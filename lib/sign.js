"use strict";
// Signed verdicts.
//
// The unsigned marker proves "this tree was seen by the gate on this machine" -
// it is a JSON file anyone can write. Signing the trailer with the developer's
// SSH key makes a different claim: this specific tree, at commit time, was
// approved by the holder of that key, and the signature travels with the commit
// so a clone can check it without this machine or this tool's state directory.
//
// Trust model, stated plainly: a self-contained signature proves *a* key signed
// that tree. Identity needs an anchor - `.signoff/allowed_signers` in the repo
// (committed) or `signoff.json` `allowed_signers`. Without one, audit reports the
// commit as "self-signed", never as "verified".

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("./core");

const NAMESPACE = "signoff";

function run(args, opts) {
  const r = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    windowsHide: true,
    input: opts && opts.input,
    cwd: opts && opts.cwd,
    env: { ...process.env, ...((opts && opts.env) || {}) },
  });
  return { code: r.status === null ? 127 : r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function haveSshKeygen() {
  const r = run(["ssh-keygen", "-Y", "sign", "-h"]);
  // ssh-keygen prints usage and exits 1 when the flag set is valid but args are missing.
  return !/not found|is not recognized|ENOENT/i.test(r.err) && r.code !== 127;
}

// Candidate private keys, in priority order. SIGNOFF_SIGN_KEY wins so tests and
// CI can pin one without touching git config; `signoff init --sign` pins the repo's
// own key in .signoff/config.json so the choice survives a fresh shell.
function candidates() {
  const out = [];
  if (process.env.SIGNOFF_SIGN_KEY) out.push(process.env.SIGNOFF_SIGN_KEY);
  const repo = repoConfigKey();
  if (repo) out.push(repo);
  const cfg = run(["git", "config", "--get", "user.signingkey"]);
  if (cfg.code === 0 && cfg.out) out.push(cfg.out);
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  for (const n of ["id_ed25519", "id_rsa", "id_ecdsa"]) out.push(path.join(home, ".ssh", n));
  return out;
}

function repoConfigKey() {
  const top = run(["git", "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const cfg = core.readJSON(path.join(top.out, ".signoff", "config.json"), {}) || {};
  return typeof cfg.sign_key === "string" && cfg.sign_key ? cfg.sign_key : null;
}

// A repo-local key: not an identity claim, but it makes every commit tamper-evident
// against accidental trailer edits, and it costs one flag.
function generateKey(dir) {
  if (!haveSshKeygen()) return null;
  const keyPath = path.join(dir, "signing_key");
  if (fs.existsSync(keyPath)) return keyPath;
  fs.mkdirSync(dir, { recursive: true });
  const r = run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "signoff-local", "-f", keyPath]);
  if (r.code !== 0) return null;
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch (e) {
    /* windows ignores the mode */
  }
  return keyPath;
}

function findKey() {
  for (const raw of candidates()) {
    const p = String(raw).replace(/^~/ , (process.env.HOME || process.env.USERPROFILE || "").replace(/\\/g, "/"));
    if (!fs.existsSync(p)) continue;
    if (fs.existsSync(p + ".pub") || /PRIVATE KEY/.test(safeRead(p))) return p;
  }
  return null;
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    return "";
  }
}

function pubkeyOf(keyPath) {
  const pub = safeRead(keyPath + ".pub").trim();
  if (pub) return pub;
  const r = run(["ssh-keygen", "-y", "-f", keyPath]);
  return r.code === 0 ? r.out : "";
}

// Sign the tree string. Returns {key, sig} where sig is base64 of the armored
// signature so it survives as a one-line git trailer.
function sign(tree) {
  if (!tree || !haveSshKeygen()) return null;
  const keyPath = findKey();
  if (!keyPath) return null;
  const key = pubkeyOf(keyPath);
  if (!key) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-sign-"));
  const data = path.join(dir, "tree.txt");
  try {
    fs.writeFileSync(data, tree, "utf8");
    const r = run(["ssh-keygen", "-Y", "sign", "-f", keyPath, "-n", NAMESPACE, data]);
    if (r.code !== 0) return null;
    const armored = safeRead(data + ".sig");
    if (!armored) return null;
    return { key, sig: Buffer.from(armored, "utf8").toString("base64") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Verify a trailer pair. `allowed` is a list of pubkey lines (or fingerprints);
// empty means self-signed only.
function verify(tree, key, sigB64, allowed) {
  if (!tree || !key || !sigB64) return { ok: false, state: "unsigned", reason: "no signature" };
  if (!haveSshKeygen()) return { ok: false, state: "unverifiable", reason: "ssh-keygen not available" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-verify-"));
  try {
    const sigFile = path.join(dir, "tree.sig");
    const allowedFile = path.join(dir, "allowed_signers");
    fs.writeFileSync(sigFile, Buffer.from(sigB64, "base64").toString("utf8"), "utf8");
    fs.writeFileSync(allowedFile, `signoff ${key}\n`, "utf8");
    // ssh-keygen -Y verify reads the signed message on stdin, not as an argument.
    const r = run(
      ["ssh-keygen", "-Y", "verify", "-f", allowedFile, "-I", "signoff", "-n", NAMESPACE, "-s", sigFile],
      { input: tree }
    );
    if (r.code !== 0) return { ok: false, state: "bad-signature", reason: (r.err || r.out || "verify failed").split("\n")[0] };
    const trusted = matchAllowed(key, allowed);
    return { ok: true, state: trusted ? "verified" : "self-signed", reason: trusted ? "key is in allowed_signers" : "key not in allowed_signers" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// allowed entries may be full pubkey lines, or just the base64 blob, or a
// fingerprint like SHA256:abc... . Compare what we have against all three.
function matchAllowed(key, allowed) {
  if (!allowed || !allowed.length) return false;
  const blob = key.split(/\s+/)[1] || "";
  const fp = fingerprint(key);
  for (const a of allowed) {
    const s = String(a).trim();
    if (!s || s.startsWith("#")) continue;
    if (s === key || s === blob) return true;
    if (s.split(/\s+/)[1] === blob) return true;
    if (fp && s === fp) return true;
  }
  return false;
}

let fpCache = null;
function fingerprint(key) {
  if (fpCache !== null) return fpCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-fp-"));
  try {
    const f = path.join(dir, "key.pub");
    fs.writeFileSync(f, key + "\n", "utf8");
    const r = run(["ssh-keygen", "-lf", f]);
    fpCache = r.code === 0 ? r.out.split(/\s+/)[1] || "" : "";
    return fpCache;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The repo's trust anchor: priority to the committed allowlist, then the declaration.
function allowedKeys(root) {
  const out = [];
  for (const rel of [".signoff/allowed_signers", "allowed_signers", "signoff.allowed_signers"]) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    for (const ln of safeRead(p).split(/\r?\n/)) {
      const s = ln.trim();
      if (s && !s.startsWith("#")) out.push(s);
    }
  }
  const decl = core.readJSON(path.join(root, "signoff.json"), {}) || {};
  for (const k of [].concat(decl.allowed_signers || [])) if (typeof k === "string") out.push(k);
  return out;
}

module.exports = { sign, verify, allowedKeys, findKey, pubkeyOf, haveSshKeygen, matchAllowed, generateKey, NAMESPACE };

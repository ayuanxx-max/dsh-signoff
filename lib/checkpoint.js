"use strict";
// Signed checkpoints for the P4 ledger.
//
// The ledger is already an append-only hash chain, which catches edits but not
// deletion: truncate the file and every remaining line still verifies. A
// checkpoint is a signed statement "at seq N the head was H and the tree root was
// R"; it is written once, shipped somewhere the repo cannot reach (release notes,
// CI summary, a colleague's message), and any later truncation or rewrite shows up
// as a mismatch. The anchor line is the thing you publish:
//
//   signoff1:<seq>:<head12>:<root16>

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const p4 = require("./p4");
const core = require("./core");
const signlib = require("./sign");

const VERSION = 1;
const PREFIX = "signoff1";

function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

function checkpointPath() {
  return path.join(path.dirname(p4.ledgerPath()), "checkpoint.json");
}

// Binary Merkle root over the per-record hashes; an odd node is paired with
// itself, the usual convention, so the root is stable for any length.
function merkleRoot(hashes) {
  if (!hashes.length) return sha256("signoff:empty");
  let level = hashes.map((h) => sha256("leaf:" + h));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : a;
      next.push(sha256("node:" + a + b));
    }
    level = next;
  }
  return level[0];
}

// The exact bytes a signature covers. Versioned so a future format cannot be
// replayed against this one.
function payload(seq, head, root) {
  return ["signoff-checkpoint", "v" + VERSION, String(seq), head, root].join("\n");
}

function anchorOf(seq, head, root) {
  return `${PREFIX}:${seq}:${String(head).slice(0, 12)}:${String(root).slice(0, 16)}`;
}

function summarize() {
  const chain = p4.entries();
  const head = chain.length ? String(chain[chain.length - 1].hash || "") : "genesis";
  const root = merkleRoot(chain.map((r) => String(r.hash || "")));
  return { seq: chain.length, head, root, chain };
}

function create(opts) {
  const o = opts || {};
  const s = summarize();
  const body = payload(s.seq, s.head, s.root);
  let key = null;
  let sig = null;
  if (o.sign !== false) {
    // A checkpoint nobody can attribute is decoration. If the machine has no key,
    // make a repo-local one (same convention as guard --sign) instead of silently
    // producing an unsigned file.
    let keyPath = signlib.findKey();
    if (!keyPath) {
      keyPath = signlib.generateKey(path.join(path.dirname(p4.ledgerPath()), "keys"));
      if (keyPath) process.env.SIGNOFF_SIGN_KEY = keyPath;
    }
    const signed = signlib.sign(body);
    if (signed) {
      key = signed.key;
      sig = signed.sig;
    }
  }
  const cp = {
    version: VERSION,
    seq: s.seq,
    head: s.head,
    root: s.root,
    ts: p4.timestamp(),
    repo: p4.repoKey(),
    key: key,
    sig: sig,
    anchor: anchorOf(s.seq, s.head, s.root),
  };
  const file = o.file || checkpointPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cp, null, 2) + "\n", "utf8");
  return { ok: true, file, checkpoint: cp };
}

function readCheckpoint(file) {
  const f = file || checkpointPath();
  if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return d && typeof d === "object" ? d : null;
  } catch (e) {
    return null;
  }
}

// Why a checkpoint would not verify, in the order a reader should care about:
// missing, truncated (rollback), rewritten, bad signature.
function verdict(cp, opts) {
  const o = opts || {};
  const root = o.root || process.cwd();
  const problems = [];
  if (!cp) {
    return { ok: false, state: "missing", problems: ["no checkpoint written yet"] };
  }
  let chain;
  try {
    chain = p4.entries();
  } catch (e) {
    return { ok: false, state: "unreadable", problems: [String((e && e.message) || e)] };
  }
  const seq = Number(cp.seq);
  const head = String(cp.head || "");
  const rootHash = String(cp.root || "");
  if (!Number.isFinite(seq) || seq < 0) problems.push("checkpoint seq is not a number");
  if (!/^[0-9a-f]{64}$/.test(head) && head !== "genesis") problems.push("checkpoint head is not a hash");
  if (seq > chain.length) {
    problems.push(`ledger has ${chain.length} records but the checkpoint covers ${seq} (records were removed)`);
  } else {
    const actualHead = seq === 0 ? "genesis" : String(chain[seq - 1].hash || "");
    if (actualHead !== head) problems.push(`record ${seq} hashes to ${actualHead.slice(0, 12)}, checkpoint says ${head.slice(0, 12)}`);
    const actualRoot = merkleRoot(chain.slice(0, seq).map((r) => String(r.hash || "")));
    if (actualRoot !== rootHash) problems.push("tree root does not match the checkpoint");
  }
  if (o.anchor) {
    const want = anchorOf(seq, head, rootHash);
    const got = core.pyStrip ? core.pyStrip(String(o.anchor)) : String(o.anchor).trim();
    if (got !== want) problems.push(`published anchor '${got}' does not match local '${want}'`);
  }
  // Signature last: a chain that already fails cannot be rescued by a valid sig.
  let state = "unsigned";
  if (!problems.length) {
    if (!cp.key || !cp.sig) {
      if (!o.allowUnsigned) problems.push("checkpoint is not signed");
    } else {
      const allowed = signlib.allowedKeys(root);
      const r = signlib.verify(payload(seq, head, rootHash), cp.key, cp.sig, allowed);
      state = r.state;
      if (!r.ok || state === "bad-signature" || state === "unverifiable") {
        problems.push("signature: " + (r.reason || state));
      }
    }
  }
  return {
    ok: problems.length === 0,
    state: problems.length && state === "unsigned" ? "unsigned" : state,
    seq,
    head,
    root: rootHash,
    anchor: anchorOf(seq, head, rootHash),
    problems,
  };
}

module.exports = {
  VERSION,
  PREFIX,
  create,
  readCheckpoint,
  verdict,
  summarize,
  merkleRoot,
  payload,
  anchorOf,
  checkpointPath,
};

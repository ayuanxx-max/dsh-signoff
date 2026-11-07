"use strict";
// Shared helpers for the JavaScript gate implementations.
// The gates are pure Node (>=18) on purpose: `npm i -g signoff-cli` must give the
// full P1-P5 set on any machine that can run npm, with no Python and no degraded mode.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function readJSON(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return dflt;
  }
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

function stateDir(cwd) {
  const d = path.join(cwd || process.cwd(), ".signoff");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function statePath(cwd, name) {
  return path.join(stateDir(cwd), name);
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd: cwd || process.cwd(), encoding: "utf8", windowsHide: true });
  return { code: r.status === null ? 127 : r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function json(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function die(msg, code) {
  process.stderr.write(String(msg) + "\n");
  return code === undefined ? 1 : code;
}

// Minimal argv parser: `--flag`, `--key value`, `--key=value`, positionals.
function parseArgs(argv, spec) {
  const out = { _: [] };
  for (const [k, v] of Object.entries(spec || {})) out[k] = v;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      let val;
      if (eq !== -1) val = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) val = argv[++i];
      else val = true;
      if (out[key] === undefined || Array.isArray(out[key])) {
        if (Array.isArray(out[key])) out[key].push(val);
        else out[key] = val;
      } else if (val === true) out[key] = true;
      else out[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + "\n", "utf8");
}

function sha256(text) {
  return require("crypto").createHash("sha256").update(text, "utf8").digest("hex");
}

// ~/.signoff, overridable for tests and for machines with a different home layout.
function homeDir() {
  const override = process.env.SIGNOFF_HOME;
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const h = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const d = path.join(h, ".signoff");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = {
  ROOT,
  nowISO,
  readJSON,
  writeJSON,
  writeText,
  stateDir,
  statePath,
  git,
  json,
  die,
  parseArgs,
  appendJsonl,
  sha256,
  homeDir,
};

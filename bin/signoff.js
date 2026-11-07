#!/usr/bin/env node
"use strict";

// SignOff (落印) CLI — dispatches to the five gates.
// The gates are pure Node (lib/p1..p5.js). SIGNOFF_ENGINE=python falls back to
// the reference implementation in gates/*.py, which is used only for parity tests.

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// npm >= 11 gates postinstall behind an allowlist, so the install cannot be the only
// way in: the first gate command in a repo finishes the job itself. Read-only commands
// (doctor/status/explain/audit) and the hook path stay untouched - the hook path is what
// the machine-wide guard uses, and there a light P1 is the whole point.
const BOOTSTRAP_CMDS = new Set(["p1", "p2", "p3", "p4", "p5", "all", "guard"]);
function maybeBootstrap(cmd) {
  if (!BOOTSTRAP_CMDS.has(cmd)) return;
  if (process.env.SIGNOFF_NO_BOOTSTRAP === "1") return;
  try {
    const r = require("../lib/bootstrap").ensureRepo({ quiet: true });
    if (r.installed && !process.argv.includes("--json")) {
      console.error(`signoff: guarded ${require("path").basename(r.root)} automatically (${r.changed.join(", ")})`);
    }
  } catch (e) {
    /* a convenience, never a verdict */
  }
}

const GATES = {
  p1: "p1_verify.py",
  p2: "p2_coverage.py",
  p3: "p3_queue.py",
  p4: "p4_ledger.py",
  p5: "p5_slop.py",
};

const HELP = `SignOff / 落印 — make "done" provable

  signoff p1 [--run CMD]... [--budget SEC]   gate 1  verify before you speak
  signoff p2 [--min-scenario N] [--md FILE]  gate 2  coverage has a level, not a vibe
  signoff p3 [--cards DIR] plan|collect ...  gate 3  parallel work, no collisions
  signoff p4 ask|confirm|verify|export ...   gate 4  risky actions leave a ledger
  signoff p4 export --merge OTHER...        merge another repo's ledger into one table
  signoff p4 export --format {md,json,csv}  pick the export shape
  signoff p5 [FILES...]                      gate 5  empty words are a failure

  signoff p1 --install-hook                  drop a git pre-commit hook
  signoff all                                p1, p2, p5, then p4 verify
  signoff doctor [--fix]                     show what is present; --fix repairs what it can prove

  signoff init [--no-ci] [--prepare] [--quiet]  install hooks + CI so the gates run themselves
  signoff init --share                       also write signoff.json, so every clone opts in
  signoff init --chain | --lock-test | --reset-install   keep existing hooks / pin the
                                             detected runner / move the install point to HEAD
  signoff ensure [--global] [--json]         idempotent install; gates also self-install
                                             (--global = guard every repo on this machine)
  signoff guard [--full]                     run the gate set the hooks use (right now)
  signoff status                             is this repo guarded?
signoff doctor [--json] [--fix]            why is (or isn't) it guarded? --fix repairs it
  signoff explain <p1..p5>                   what a gate checks and how it decides
  signoff mcp                                serve the gates over stdio (MCP clients)
  signoff audit [--range A..B] [--strict]    did the commits that landed carry a trailer?
  signoff audit --since-install             only commits after the install point (refuses
                                             a point that is not an ancestor of HEAD)
  signoff uninstall [--keep-config] [--all]  remove hooks + CI workflow

Requires Node >= 18 only; no Python. Options common to every gate: --json, -h.
`;

function python() {
  return process.env.SIGNOFF_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function jsGate(name) {
  const file = path.join(__dirname, "..", "lib", `${name}.js`);
  return fs.existsSync(file) ? file : null;
}

function runGate(name, args) {
  if (process.env.SIGNOFF_ENGINE !== "python" && jsGate(name)) {
    try {
      return require(jsGate(name)).run(args) || 0;
    } catch (e) {
      console.error(`signoff: ${name} failed: ${e && e.message}`);
      return 1;
    }
  }
  const file = path.join(__dirname, "..", "gates", GATES[name]);
  if (!fs.existsSync(file)) {
    console.error(`signoff: missing gate script ${file}`);
    return 127;
  }
  const r = spawnSync(python(), [file, ...args], { stdio: "inherit" });
  if (r.error) {
    console.error(`signoff: cannot start ${python()} (${r.error.message}). Set SIGNOFF_PYTHON.`);
    return 127;
  }
  return r.status === null ? 1 : r.status;
}

function runAll(args) {
  const steps = [
    ["p1", args],
    ["p2", args],
    ["p5", []],
    ["p4", ["verify"]],
  ];
  let code = 0;
  for (const [name, a] of steps) {
    console.log(`\n== signoff ${name} ==`);
    const c = runGate(name, a);
    if (c !== 0) code = c;
  }
  return code;
}

function guard(sub, args) {
  const file = path.join(__dirname, "..", "lib", "guard.js");
  if (fs.existsSync(file)) {
    try {
      return require(file).main([sub, ...args]) || 0;
    } catch (e) {
      console.error(`signoff: guard failed: ${e && e.message}`);
      return 1;
    }
  }
  const py = path.join(__dirname, "..", "gates", "guard.py");
  const r = spawnSync(python(), [py, sub, ...args], { stdio: "inherit" });
  if (r.error) {
    console.error(`signoff: cannot start ${python()} (${r.error.message}). Set SIGNOFF_PYTHON.`);
    return 127;
  }
  return r.status === null ? 1 : r.status;
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}
if (cmd === "-v" || cmd === "--version" || cmd === "version") {
  console.log(require("../package.json").version);
  process.exit(0);
}
if (cmd === "doctor") process.exit(require("../lib/doctor").run(rest));
if (cmd === "ensure") process.exit(require("../lib/bootstrap").run(rest));
if (cmd === "all") {
  maybeBootstrap("all");
  process.exit(runAll(rest));
}
if (cmd === "init") process.exit(guard("init", rest));
if (cmd === "guard") {
  maybeBootstrap("guard");
  process.exit(guard("guard", rest));
}
if (cmd === "hook") process.exit(guard("hook", rest));
if (cmd === "status") process.exit(guard("status", rest));
if (cmd === "uninstall") {
  if (rest.includes("--global")) {
    const r = require("../lib/bootstrap").uninstallGlobal();
    console.log(r.removed ? `signoff: machine layer removed (${r.dir})` : "signoff: machine layer was not installed");
    process.exit(0);
  }
  process.exit(guard("uninstall", rest));
}
if (cmd === "audit") {
  try {
    process.exit(require(path.join(__dirname, "..", "lib", "audit.js")).run(rest) || 0);
  } catch (e) {
    console.error(`signoff: audit failed: ${e && e.message}`);
    process.exit(1);
  }
}
if (cmd === "explain") process.exit(require("../lib/explain.js").run(rest));
if (cmd === "mcp") {
  // stdio JSON-RPC; the module wires stdin and stays alive until the client closes it.
  require("../integrations/mcp/server.js");
  return;
}
if (GATES[cmd]) {
  maybeBootstrap(cmd);
  process.exit(runGate(cmd, rest));
}

console.error(`signoff: unknown command "${cmd}"\n`);
console.error(HELP);
process.exit(2);

#!/usr/bin/env node
"use strict";

// SignOff (一诺过五关) CLI — dispatches to the five gates.
// Gates are Python 3 (stdlib only). Set SIGNOFF_PYTHON to pick an interpreter.

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const GATES = {
  p1: "p1_verify.py",
  p2: "p2_coverage.py",
  p3: "p3_queue.py",
  p4: "p4_ledger.py",
  p5: "p5_slop.py",
};

const HELP = `SignOff / 一诺过五关 — make "done" provable

  signoff p1 [--run CMD]... [--budget SEC]   gate 1  verify before you speak
  signoff p2 [--min-scenario N] [--md FILE]  gate 2  coverage has a level, not a vibe
  signoff p3 [--cards DIR] plan|collect ...  gate 3  parallel work, no collisions
  signoff p4 ask|confirm|verify|export ...   gate 4  risky actions leave a ledger
  signoff p5 [FILES...]                      gate 5  empty words are a failure

  signoff p1 --install-hook                  drop a git pre-commit hook
  signoff all                                p1, p2, p5, then p4 verify
  signoff doctor                             show what is present in this repo

  signoff init [--no-ci]                     install hooks + CI so the gates run themselves
  signoff guard [--full]                     run the gate set the hooks use (right now)
  signoff status                             is this repo guarded?
  signoff uninstall [--all]                  remove hooks + CI workflow

Options common to every gate: --json (machine readable), -h.
`;

function python() {
  return process.env.SIGNOFF_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function gateFile(name) {
  return path.join(__dirname, "..", "gates", GATES[name]);
}

function runGate(name, args) {
  const file = gateFile(name);
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

function doctor() {
  const rows = [
    ["node", process.version],
    ["python", python()],
    ["gates", path.join(__dirname, "..", "gates")],
    ["cwd", process.cwd()],
    ["git", fs.existsSync(".git") ? "yes" : "no"],
    ["tests/", fs.existsSync("tests") ? "yes" : "no"],
    ["verify/scenarios/", fs.existsSync("verify/scenarios") ? "yes" : "no"],
    ["tasks/", fs.existsSync("tasks") ? "yes" : "no"],
    [".signoff/", fs.existsSync(".signoff") ? "yes" : "no"],
  ];
  for (const [k, v] of rows) console.log(`${k.padEnd(20)} ${v}`);
  const g = spawnSync(python(), [path.join(__dirname, "..", "gates", "guard.py"), "status", "--json"], {
    encoding: "utf8",
  });
  let guard = "not installed (run: signoff init)";
  if (g.status === 0 && g.stdout) {
    try {
      const st = JSON.parse(g.stdout).installed;
      const on = ["pre-commit", "pre-push", "ci"].filter((k) => st[k]);
      guard = on.length ? `${on.join(", ")} (${JSON.parse(g.stdout).version})` : "not installed (run: signoff init)";
    } catch (e) {
      /* keep the default */
    }
  }
  console.log(`${"guard".padEnd(20)} ${guard}`);
  return 0;
}

function runGuard(sub, args) {
  const file = path.join(__dirname, "..", "gates", "guard.py");
  const r = spawnSync(python(), [file, sub, ...args], { stdio: "inherit" });
  if (r.error) {
    console.error(`signoff: cannot start ${python()} (${r.error.message}). Set SIGNOFF_PYTHON.`);
    return 127;
  }
  return r.status === null ? 1 : r.status;
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(HELP);
  process.exit(cmd ? 0 : 0);
}
if (cmd === "doctor") process.exit(doctor());
if (cmd === "all") process.exit(runAll(rest));
if (cmd === "init") process.exit(runGuard("init", rest));
if (cmd === "guard") process.exit(runGuard("guard", rest));
if (cmd === "hook") process.exit(runGuard("hook", rest));
if (cmd === "status") process.exit(runGuard("status", rest));
if (cmd === "uninstall") process.exit(runGuard("uninstall", rest));
if (GATES[cmd]) process.exit(runGate(cmd, rest));

console.error(`signoff: unknown command "${cmd}"\n`);
console.error(HELP);
process.exit(2);

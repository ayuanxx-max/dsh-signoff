"use strict";
// Gate 1 — "verify before you speak".
// Port of gates/p1_verify.py: same flags, same defaults, same JSON, same human
// lines, same state file (.signoff/p1.json), same exit codes (0 pass / 1 fail /
// 2 usage). Pure Node, CommonJS, no Python.
//
// The reference implementation is the source of truth; every branch below says
// which Python line it mirrors when the behaviour is not obvious.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { statePath, writeJSON } = require("./core");

const USAGE =
  "usage: signoff p1 [-h] [--run RUN] [--budget BUDGET] [--install-hook] [--json] [--quiet]";

const HELP =
  USAGE +
  "\n\n" +
  [
    "options:",
    "  -h, --help            show this help message and exit",
    "  --run RUN             command to run (repeatable)",
    "  --budget BUDGET       seconds for all commands together (default: 180.0)",
    "  --install-hook        write .git/hooks/pre-commit",
    "  --json                print the verdict as one JSON line",
    "  --quiet               suppress the per-command line",
  ].join("\n") +
  "\n";

// --- case counting ---------------------------------------------------------
// Order matters and is byte-identical to the Python: the first pattern that has
// a hit wins, and the answer is the largest number it saw.
const CASE_PATTERNS = [
  /(\d+)\s+passed/g,
  /(\d+)\s+tests?\b/g,
  /(\d+)\s+checks?\b/g,
  /(\d+)\s+assertions?\b/g,
];

function countCases(text) {
  for (const re of CASE_PATTERNS) {
    let best = null;
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      if (best === null || n > best) best = n;
    }
    if (best !== null) return best;
  }
  return null;
}

// --- Python string primitives ---------------------------------------------
// str.splitlines() breaks on more than \n: \r, \v, \f, \x1c-\x1e, \x85, U+2028,
// U+2029. `tail` must contain the same strings as the Python version.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function splitLines(text) {
  const lines = text.split(LINE_BREAK);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// str.isspace() characters, so str.strip() and JS trim() agree.
const WS =
  "[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const LEAD_TRAIL = new RegExp("^" + WS + "+|" + WS + "+$", "g");

function pyStrip(s) {
  return s.replace(LEAD_TRAIL, "");
}

// --- helpers ---------------------------------------------------------------
function nowMs() {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function pythonExe() {
  return process.env.SIGNOFF_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function shellQuote(s) {
  return /[\s]/.test(s) ? `"${s}"` : s;
}

// Mirrors default_commands(): tests/ means pytest, else package.json means npm.
function defaultCommands(cwd) {
  if (isDir(path.join(cwd, "tests"))) return [`${shellQuote(pythonExe())} -m pytest tests -q`];
  if (fs.existsSync(path.join(cwd, "package.json"))) return ["npm test --silent"];
  return [];
}

// json.dumps(obj, ensure_ascii=False) — default separators, i.e. ", " and ": ".
// Only used for the flat one-line verdict, so primitives are all we need.
function pyJsonInline(obj) {
  return (
    "{" +
    Object.entries(obj)
      .map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v))
      .join(", ") +
    "}"
  );
}

// --- flags -----------------------------------------------------------------
// The five flags of the Python gate, plus prefix matching so `--bud 5` works
// like argparse does.
const OPTIONS = [
  { long: "run", key: "run", arg: "RUN", takesValue: true, multi: true },
  { long: "budget", key: "budget", arg: "BUDGET", takesValue: true },
  { long: "install-hook", key: "installHook", arg: null },
  { long: "json", key: "json", arg: null },
  { long: "quiet", key: "quiet", arg: null },
  { long: "help", key: "help", arg: null },
];

const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;
const FLOAT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function resolveOption(tok) {
  if (tok === "-h") return OPTIONS.find((o) => o.key === "help");
  if (!tok.startsWith("--")) return null;
  const name = tok.slice(2);
  const exact = OPTIONS.find((o) => o.long === name);
  if (exact) return exact;
  const cands = OPTIONS.filter((o) => o.long.startsWith(name));
  return cands.length === 1 ? cands[0] : null;
}

function isOptionToken(tok) {
  if (tok === "-") return false; // argparse treats a lone "-" as a value
  if (!tok.startsWith("-")) return false;
  return !NEGATIVE_NUMBER.test(tok);
}

function parse(argv) {
  const a = { run: [], budget: 180.0, installHook: false, json: false, quiet: false, help: false };
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = String(argv[i]);
    if (tok === "--") {
      for (i++; i < argv.length; i++) extra.push(String(argv[i]));
      break;
    }
    if (!tok.startsWith("-") || tok === "-") {
      extra.push(tok);
      continue;
    }
    let name = tok;
    let inline = null;
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      name = tok.slice(0, eq);
      inline = tok.slice(eq + 1);
    }
    const opt = resolveOption(name);
    if (!opt) return { error: `unrecognized arguments: ${tok}` };
    if (!opt.takesValue) {
      if (inline !== null) return { error: `argument ${name}: ignored explicit argument '${inline}'` };
      a[opt.key] = true;
      continue;
    }
    let val;
    if (inline !== null) val = inline;
    else if (i + 1 < argv.length && !isOptionToken(String(argv[i + 1]))) val = String(argv[++i]);
    else return { error: `argument ${name}: expected one argument` };
    if (opt.multi) a[opt.key].push(val);
    else a[opt.key] = val;
  }
  if (extra.length) return { error: `unrecognized arguments: ${extra.join(" ")}` };

  const raw = String(a.budget);
  if (!FLOAT.test(raw)) return { error: `argument --budget: invalid float value: '${raw}'` };
  a.budget = Number(raw);
  // `nan`/`inf` parse in Python but then blow up in int(budget * 1000); calling
  // that a usage error is the only portable answer.
  if (!Number.isFinite(a.budget)) return { error: `argument --budget: invalid float value: '${raw}'` };
  return a;
}

// --- --install-hook --------------------------------------------------------
function installHook(cwd) {
  const hooks = path.join(cwd, ".git", "hooks");
  if (!isDir(hooks)) {
    console.log("[p1] not a git repository (no .git/hooks)");
    return 2;
  }
  const hook = path.join(hooks, "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\n# installed by SignOff / dsh-signoff\nexec signoff p1\n", "utf8");
  try {
    fs.chmodSync(hook, 0o755);
  } catch (e) {
    /* chmod is a no-op on Windows, exactly like the Python try/except */
  }
  console.log(`[p1] hook installed: ${hook}`);
  return 0;
}

// --- main ------------------------------------------------------------------
function run(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const a = parse(args);

  if (a.error) {
    process.stderr.write(USAGE + "\n");
    process.stderr.write(`signoff p1: error: ${a.error}\n`);
    return 2;
  }
  if (a.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const cwd = process.cwd();
  if (a.installHook) return installHook(cwd);

  const cmds = a.run.length ? a.run : defaultCommands(cwd);
  if (!cmds.length) {
    console.log("[p1] nothing to run: no tests/ and no package.json");
    return 2;
  }

  const started = nowMs();
  const results = [];
  for (const cmd of cmds) {
    const t0 = nowMs();
    const r = spawnSync(cmd, {
      shell: true,
      cwd,
      encoding: "buffer",
      // Python buffers everything; 64 MiB is the honest middle ground.
      maxBuffer: 64 * 1024 * 1024,
    });
    const ms = Math.round(nowMs() - t0);
    // Python: text=True, errors="replace" — undecodable bytes become U+FFFD.
    const out =
      (r.stdout ? r.stdout.toString("utf8") : "") + (r.stderr ? r.stderr.toString("utf8") : "");
    let rc;
    if (r.status === null) {
      // Killed by a signal: Python reports -signum.
      rc = -(os.constants.signals[r.signal] || 1);
    } else {
      rc = r.status;
    }
    results.push({ cmd, rc, ms, cases: countCases(out), tail: splitLines(pyStrip(out)).slice(-3) });
    if (!a.quiet) console.log(`[p1] rc=${rc} ${ms} ms  ${cmd}`);
  }

  const elapsed = Math.round(nowMs() - started);
  const budgetMs = Math.trunc(a.budget * 1000);
  const ok = results.every((r) => r.rc === 0) && elapsed <= a.budget * 1000;
  const totalCases = results.reduce((n, r) => n + (r.cases || 0), 0);
  const payload = {
    gate: "p1",
    ok,
    elapsedMs: elapsed,
    budgetMs,
    cases: totalCases,
    results,
  };
  writeJSON(statePath(cwd, "p1.json"), payload);

  if (a.json) {
    console.log(
      pyJsonInline({ gate: payload.gate, ok, elapsedMs: elapsed, budgetMs, cases: totalCases })
    );
  } else {
    console.log(`[p1] ${ok ? "PASS" : "FAIL"} ${elapsed} ms (budget ${budgetMs} ms), cases=${totalCases}`);
  }
  return ok ? 0 : 1;
}

module.exports = { run };

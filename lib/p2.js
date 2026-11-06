#!/usr/bin/env node
"use strict";
// SignOff gate 2 - coverage has a level, not a vibe.
//
// Node port of gates/p2_coverage.py, which stays the reference implementation.
// Parity with it is the point: same flags and defaults, same exit codes, same
// stdout (including Python's text-mode newline translation), same `.signoff/p2.json`
// and same `--md` table. App discovery, scenario counting, grading and thresholds
// are ported line by line, so a difference here is a bug.

const fs = require("fs");
const path = require("path");
const core = require("./core");

// Python writes text (stdout, write_text) through a TextIOWrapper with newline=None,
// which turns every "\n" into os.linesep. On Windows the reference gate therefore
// emits CRLF; the port has to do the same or the bytes differ.
const EOL = process.platform === "win32" ? "\r\n" : "\n";
const SKIP_DIRS = new Set(["node_modules", "docs", "gates", "bin", "test"]);
// The ladder the four level names encode; kept because the reference gate defines it.
const LEVELS = { missing: 0, smoke: 1, harness: 2, scenario: 3 };
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/; // argparse's _negative_number_matcher
const OPTIONS = ["help", "min-scenario", "min-assertions", "strict", "md", "json"];
const USAGE = `usage: signoff p2 [-h] [--min-scenario MIN_SCENARIO]
                  [--min-assertions MIN_ASSERTIONS] [--strict] [--md FILE]
                  [--json]`;
const HELP = `${USAGE}

options:
  -h, --help            show this help message and exit
  --min-scenario MIN_SCENARIO
                        require at least N scenario-level apps
  --min-assertions MIN_ASSERTIONS
  --strict              fail on missing/harness/broken
  --md FILE             write a markdown table
  --json
`;

// --- Python shims ---------------------------------------------------------

function eol(text) {
  return text.split("\n").join(EOL);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

// len()/slicing/formatting in Python count code points, not UTF-16 units.
function cps(s) {
  return Array.from(String(s));
}

function cut(s, n) {
  return cps(s).slice(0, n).join("");
}

function pad(s, width) {
  const len = cps(s).length;
  return len >= width ? s : s + " ".repeat(width - len);
}

// `name[:-5]` - drop the ".json" suffix, in code points like Python slices.
function stripJson(name) {
  const parts = cps(name);
  return parts.slice(0, Math.max(0, parts.length - 5)).join("");
}

// pathlib sorts Paths by their normcased parts: case-insensitive on Windows.
function nameCmp(a, b) {
  const ka = process.platform === "win32" ? a.toLowerCase() : a;
  const kb = process.platform === "win32" ? b.toLowerCase() : b;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Python text mode reads files strictly as UTF-8 and keeps a leading BOM, which
// json.loads then rejects. TextDecoder must do exactly the same.
function readUtf8Strict(p) {
  const buf = fs.readFileSync(p); // directories and missing files throw, like read_text
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
}

// json.dumps with the default separators (", " / ": ").
function dumpComma(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(dumpComma).join(", ") + "]";
  return (
    "{" +
    Object.keys(obj)
      .map((k) => JSON.stringify(k) + ": " + dumpComma(obj[k]))
      .join(", ") +
    "}"
  );
}

function attrError(data) {
  const t =
    data === null ? "NoneType"
    : Array.isArray(data) ? "list"
    : typeof data === "string" ? "str"
    : typeof data === "boolean" ? "bool"
    : "int";
  return new Error(`'${t}' object has no attribute 'get'`);
}

// --- the gate -------------------------------------------------------------

function appDirs(root) {
  const found = [];
  if (exists(path.join(root, "package.json")) || isDir(path.join(root, "verify"))) {
    found.push(root);
  }
  for (const base of [root, path.join(root, "packages"), path.join(root, "apps")]) {
    if (!isDir(base)) continue;
    const names = fs.readdirSync(base).sort(nameCmp);
    for (const name of names) {
      const d = path.join(base, name);
      if (!isDir(d) || name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      if (exists(path.join(d, "package.json")) || isDir(path.join(d, "verify"))) {
        found.push(d);
      }
    }
  }
  return found;
}

function scenarioChecks(p) {
  let data;
  try {
    data = JSON.parse(readUtf8Strict(p));
  } catch (e) {
    // OSError / ValueError (bad UTF-8, bad JSON, missing file, directory) -> -1
    return -1;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw attrError(data);
  const checks = data.checks;
  return Array.isArray(checks) ? checks.length : -1;
}

function inspect(app) {
  const sdir = path.join(app, "verify", "scenarios");
  const scenarios = [];
  if (isDir(sdir)) {
    const files = fs
      .readdirSync(sdir)
      .filter((name) => (process.platform === "win32" ? name.toLowerCase() : name).endsWith(".json"))
      .sort(nameCmp);
    for (const name of files) {
      scenarios.push({ file: name, checks: scenarioChecks(path.join(sdir, name)) });
    }
  }
  const broken = scenarios.filter((s) => s.checks < 0);
  let level;
  if (scenarios.length && !broken.length) level = "scenario";
  else if (isDir(path.join(app, "verify"))) level = "harness";
  else if (exists(path.join(app, "package.json"))) level = "smoke";
  else level = "missing";
  const assertions = scenarios.reduce((n, s) => n + (s.checks > 0 ? s.checks : 0), 0);
  return {
    app: path.basename(app) || "",
    level,
    scenarios,
    assertions,
    broken: broken.map((s) => s.file),
  };
}

// "menu(11), perf(6)" - the per-app scenario list both the table and the md reuse.
function scenarioLabel(r) {
  return r.scenarios.map((s) => `${stripJson(s.file)}(${s.checks})`).join(", ") || "-";
}

function usageError(msg) {
  process.stderr.write(eol(`${USAGE}\nsignoff p2: error: ${msg}\n`));
}

// argparse-compatible enough for the five documented flags: "--key value",
// "--key=value", unambiguous prefixes, `type=int` values and store_true flags.
function parse(argv) {
  const spec = { "min-scenario": "int", "min-assertions": "int", strict: "bool", md: "str", json: "bool", help: "bool" };
  const a = { "min-scenario": 0, "min-assertions": 0, strict: false, md: null, json: false, help: false };
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "-h") {
      a.help = true;
      continue;
    }
    if (tok === "--") {
      // argparse: a lone "--" is not accepted here; everything after it is positional
      for (let j = i; j < argv.length; j++) extra.push(argv[j]);
      break;
    }
    if (!tok.startsWith("--")) {
      if (tok.startsWith("-") && tok !== "-") throw new Error(`unrecognized arguments: ${tok}`);
      extra.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const typed = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    let name = OPTIONS.includes(typed) ? typed : null;
    if (name === null) {
      const hits = OPTIONS.filter((o) => o.startsWith(typed));
      if (hits.length > 1) throw new Error(`ambiguous option: ${tok} could match ${hits.map((h) => "--" + h).join(", ")}`);
      if (!hits.length) throw new Error(`unrecognized arguments: ${tok}`);
      name = hits[0];
    }
    const kind = spec[name];
    let val = eq === -1 ? null : tok.slice(eq + 1);
    if (kind === "bool") {
      if (val !== null) throw new Error(`argument --${name}: ignored explicit argument '${val}'`);
      a[name] = true;
      continue;
    }
    if (val === null) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && !NEGATIVE_NUMBER.test(next))) {
        throw new Error(`argument --${name}: expected one argument`);
      }
      val = next;
      i++;
    }
    if (kind === "int") {
      if (!/^[+-]?\d(?:_?\d)*$/.test(val.trim())) throw new Error(`argument --${name}: invalid int value: '${val}'`);
      a[name] = parseInt(val.trim().replace(/_/g, ""), 10);
    } else {
      a[name] = val;
    }
  }
  if (extra.length) throw new Error(`unrecognized arguments: ${extra.join(" ")}`);
  return a;
}

function run(argv) {
  let a;
  try {
    a = parse(argv || []);
  } catch (e) {
    usageError(e.message);
    return 2;
  }
  if (a.help) {
    process.stdout.write(eol(HELP));
    return 0;
  }

  const root = process.cwd();
  const apps = appDirs(root);
  const rows = apps.map(inspect);
  const scenarioApps = rows.filter((r) => r.level === "scenario");
  const assertions = rows.reduce((n, r) => n + r.assertions, 0);
  const broken = rows.filter((r) => r.broken.length);
  const ok =
    scenarioApps.length >= a["min-scenario"] &&
    assertions >= a["min-assertions"] &&
    !broken.length &&
    (!a.strict || rows.every((r) => r.level === "scenario"));

  const header = `${pad("app", 34)} ${pad("level", 9)} ${pad("scenarios", 22)} assertions`;
  const lines = [header, "-".repeat(cps(header).length)];
  for (const r of rows) {
    const names = scenarioLabel(r);
    lines.push(`${pad(cut(r.app, 33), 34)} ${pad(r.level, 9)} ${pad(cut(names, 21), 22)} ${r.assertions}`);
  }

  if (a.md) {
    const md = ["| app | level | scenarios | assertions |", "| --- | --- | --- | --- |"];
    for (const r of rows) {
      md.push(`| ${r.app} | ${r.level} | ${scenarioLabel(r)} | ${r.assertions} |`);
    }
    // Python's write_text fails when the parent directory is missing; core.writeText
    // would create it, so write directly to keep the exit code identical.
    fs.writeFileSync(path.resolve(root, a.md), eol(md.join("\n") + "\n"), "utf8");
    lines.push(`[p2] table written: ${a.md}`);
  }

  const payload = {
    gate: "p2",
    ok,
    apps: rows.length,
    scenarioApps: scenarioApps.length,
    assertions,
    broken: broken.map((b) => ({ app: b.app, files: b.broken })),
    rows,
  };
  const state = core.statePath(root, "p2.json");
  core.writeText(state, eol(JSON.stringify(payload, null, 2) + "\n"));

  if (a.json) {
    const subset = {
      gate: payload.gate,
      ok: payload.ok,
      apps: payload.apps,
      scenarioApps: payload.scenarioApps,
      assertions: payload.assertions,
    };
    process.stdout.write(eol(dumpComma(subset) + "\n"));
  } else {
    const summary = `[p2] ${ok ? "PASS" : "FAIL"} apps=${rows.length} scenario=${scenarioApps.length} assertions=${assertions} broken=${broken.length}`;
    process.stdout.write(eol(lines.join("\n") + "\n" + summary + "\n"));
  }
  return ok ? 0 : 1;
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

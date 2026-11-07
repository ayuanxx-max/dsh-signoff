"use strict";
// Line coverage for the change, not for the repo.
//
// P2 grades scenarios - it answers "was this behaviour exercised". This answers a
// narrower, harder question: of the lines this commit touches, how many did the
// suite actually execute? It reads whatever the project already produces
// (istanbul JSON, python `coverage json`, lcov.info) so no extra runner is needed.

const fs = require("fs");
const path = require("path");
const core = require("./core");

const USAGE =
  "usage: signoff cov [-h] [--min PCT] [--diff] [--base REF] [--file PATH] [--json] [--allow-missing]";
const HELP =
  USAGE +
  "\n\n" +
  [
    "options:",
    "  -h, --help     show this help message and exit",
    "  --min PCT      fail when changed-line coverage is below PCT (default 80)",
    "  --diff         only count lines added by the change (default: whole files)",
    "  --base REF     diff against REF (default: HEAD, or origin/main when present)",
    "  --file PATH    read this coverage file instead of auto-detecting",
    "  --json         print one JSON line",
    "  --allow-missing pass when no coverage data exists instead of failing",
  ].join("\n") +
  "\n";

const CANDIDATES = [
  "coverage/coverage-final.json",
  "coverage.json",
  "coverage/lcov.info",
  "lcov.info",
  "coverage/lcov/lcov.info",
];

function norm(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "");
}

// ---- readers -------------------------------------------------------------

function fromPython(obj, root) {
  const out = new Map();
  for (const [file, d] of Object.entries(obj.files || {})) {
    const hit = new Set((d.executed_lines || []).map(Number));
    const miss = new Set((d.missing_lines || []).map(Number));
    const all = new Set([...hit, ...miss]);
    if (!all.size) continue;
    out.set(norm(path.isAbsolute(file) ? path.relative(root, file) : file), { hit, all });
  }
  return out;
}

function fromIstanbul(obj, root) {
  const out = new Map();
  for (const [file, d] of Object.entries(obj)) {
    if (!d || typeof d !== "object" || !d.statementMap || !d.s) continue;
    const hit = new Set();
    const all = new Set();
    for (const [id, st] of Object.entries(d.statementMap)) {
      const ln = st && st.start ? st.start.line : 0;
      if (!ln) continue;
      all.add(ln);
      if (Number((d.s || {})[id] || 0) > 0) hit.add(ln);
    }
    if (all.size) out.set(norm(path.isAbsolute(file) ? path.relative(root, file) : file), { hit, all });
  }
  return out;
}

function fromLcov(text) {
  const out = new Map();
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      cur = { file: norm(line.slice(3).trim()), hit: new Set(), all: new Set() };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("DA:")) {
      const [ln, count] = line.slice(3).split(",");
      const n = Number(ln);
      if (!n) continue;
      cur.all.add(n);
      if (Number(count) > 0) cur.hit.add(n);
    }
    if (line === "end_of_record") {
      if (cur.all.size) out.set(cur.file, { hit: cur.hit, all: cur.all });
      cur = null;
    }
  }
  if (cur && cur.all.size) out.set(cur.file, { hit: cur.hit, all: cur.all });
  return out;
}

function load(root, explicit) {
  const tried = explicit ? [explicit] : CANDIDATES;
  for (const rel of tried) {
    const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    if (/\/(coverage-final|coverage)\.json$|^coverage\.json$|\.json$/.test(rel)) {
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        continue;
      }
      const map = obj && obj.files ? fromPython(obj, root) : fromIstanbul(obj, root);
      if (map.size) return { source: rel, map };
    } else {
      const map = fromLcov(text);
      if (map.size) return { source: rel, map };
    }
  }
  return { source: null, map: new Map() };
}

// ---- diff ----------------------------------------------------------------

function baseRef(root, given) {
  if (given) return given;
  const originMain = core.git(["rev-parse", "--verify", "--quiet", "origin/main"], root);
  if (originMain.code === 0 && originMain.out.trim()) return "origin/main";
  const head = core.git(["rev-parse", "--verify", "--quiet", "HEAD"], root);
  return head.code === 0 ? "HEAD" : null;
}

// Added line numbers per file, from a zero-context diff. Deleted lines are not
// coverage targets: nothing can execute a line that no longer exists.
function changedLines(root, base) {
  const r = core.git(["diff", "--unified=0", "--no-color", base, "--"], root);
  const out = new Map();
  if (r.code !== 0) return out;
  let file = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      file = norm(line.slice(6).trim());
      continue;
    }
    if (line.startsWith("+++ ") && line.includes("/dev/null")) {
      file = null;
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || !file) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (!out.has(file)) out.set(file, new Set());
    for (let i = 0; i < count; i++) out.get(file).add(start + i);
  }
  return out;
}

function parse(argv) {
  const a = { min: 80, diff: false, base: null, file: null, json: false, allowMissing: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = String(argv[i]);
    const val = () => {
      if (tok.includes("=")) return tok.slice(tok.indexOf("=") + 1);
      if (i + 1 >= argv.length) return undefined;
      i++;
      return String(argv[i]);
    };
    if (tok === "-h" || tok === "--help") a.help = true;
    else if (tok === "--diff") a.diff = true;
    else if (tok === "--json") a.json = true;
    else if (tok === "--allow-missing") a.allowMissing = true;
    else if (tok === "--min" || tok.startsWith("--min=")) {
      const v = val();
      if (v === undefined || Number.isNaN(Number(v))) return { error: "argument --min: expected a number" };
      a.min = Number(v);
    } else if (tok === "--base" || tok.startsWith("--base=")) {
      const v = val();
      if (v === undefined) return { error: "argument --base: expected one argument" };
      a.base = v;
    } else if (tok === "--file" || tok.startsWith("--file=")) {
      const v = val();
      if (v === undefined) return { error: "argument --file: expected one argument" };
      a.file = v;
    } else if (tok.startsWith("-") && tok.length > 1) return { error: `unrecognized arguments: ${tok}` };
  }
  return a;
}

function run(argv) {
  const a = parse(argv || []);
  if (a.error) {
    process.stderr.write(USAGE + "\n" + `signoff cov: error: ${a.error}\n`);
    return 2;
  }
  if (a.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const root = core.git(["rev-parse", "--show-toplevel"], process.cwd()).out.trim() || process.cwd();
  const { source, map } = load(root, a.file);
  if (!map.size) {
    const msg = a.allowMissing ? "no coverage data (allowed)" : "no coverage data found (looked for " + CANDIDATES.join(", ") + ")";
    if (a.json) core.json({ gate: "cov", ok: !!a.allowMissing, source: null, reason: msg });
    else process.stdout.write(`[cov] ${a.allowMissing ? "PASS" : "FAIL"} ${msg}\n`);
    return a.allowMissing ? 0 : 2;
  }

  const base = baseRef(root, a.base);
  const changed = a.diff && base ? changedLines(root, base) : null;
  const files = [];
  let covered = 0;
  let total = 0;
  for (const [file, data] of map) {
    const wanted = changed ? changed.get(file) : data.all;
    if (!wanted || !wanted.size) continue;
    let fTotal = 0;
    let fHit = 0;
    for (const ln of wanted) {
      if (!data.all.has(ln)) continue; // line exists but the runner did not instrument it
      fTotal++;
      if (data.hit.has(ln)) fHit++;
    }
    if (!fTotal) continue;
    covered += fHit;
    total += fTotal;
    files.push({ file, covered: fHit, total: fTotal, pct: Math.round((fHit / fTotal) * 1000) / 10 });
  }
  files.sort((x, y) => x.pct - y.pct || x.file.localeCompare(y.file));
  const pct = total ? Math.round((covered / total) * 1000) / 10 : 100;
  const ok = total === 0 || pct >= a.min;

  core.writeJSON(path.join(root, ".signoff", "cov.json"), {
    gate: "cov",
    ok,
    source,
    base,
    mode: changed ? "diff" : "files",
    covered,
    total,
    pct,
    min: a.min,
    files,
  });

  if (a.json) {
    core.json({ gate: "cov", ok, source, mode: changed ? "diff" : "files", covered, total, pct, min: a.min, files: files.length });
  } else {
    for (const f of files.slice(0, 10)) console.log(`[cov] ${String(f.pct).padStart(5)}%  ${f.covered}/${f.total}  ${f.file}`);
    console.log(`[cov] ${ok ? "PASS" : "FAIL"} ${pct}% of ${changed ? "changed" : "instrumented"} lines (min ${a.min}%), source=${source}`);
  }
  return ok ? 0 : 1;
}

module.exports = { run, USAGE, HELP, load, changedLines, fromLcov };

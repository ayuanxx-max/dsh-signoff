"use strict";
// SignOff gate 5 - empty words are a failure. Node port of gates/p5_slop.py.
//
// Six rules over markdown. Code fences and table rows are skipped so a legitimate
// example cannot be reported as slop; the point is documents that claim progress
// without a number behind it.
//
// Parity notes (the Python reference is the contract):
//   * ROOT is the current working directory, not the package root.
//   * Python's str.strip()/splitlines()/`\b`/`\d` are Unicode-aware; the helpers
//     below reproduce those semantics because the word lists are Chinese.

const fs = require("fs");
const path = require("path");
const core = require("./core");

const WIN = process.platform === "win32";
// Python writes through text-mode streams, which turn every "\n" into os.linesep.
// Matching that keeps stdout and .signoff/p5.json byte-identical on each platform.
const NL = WIN ? "\r\n" : "\n";

const AI_WORDS = [
  "赋能", "闭环", "抓手", "颗粒度", "底层逻辑", "组合拳", "全链路", "护城河",
  "打通", "沉淀", "体系化", "复用", "生态位", "范式", "维度上", "协同增效",
];
const ABSOLUTE = ["100%", "零缺陷", "永不", "绝对", "完美", "彻底", "极致", "无缝", "彻底解决"];
const ADVERBS = ["极其", "非常", "十分", "相当", "大幅"];
const CLAIMS = /(已验证|已覆盖|全部通过|全绿|都验证过)/;
// `\b(TODO|TBD|FIXME)\b|待补|待定`, but with Python's Unicode word characters:
// a CJK ideograph counts as a word char, so "中TODO" is not a placeholder in Python.
const WORD = "[\\p{L}\\p{N}_]";
const PLACEHOLDER = new RegExp(`(?<!${WORD})(?:TODO|TBD|FIXME)(?!${WORD})|待补|待定`, "u");
// Python's re `\d` on str matches every Unicode decimal digit (category Nd).
const DIGIT = /\p{Nd}/u;

// ---------------------------------------------------------------------------
// Python str semantics

const PY_SPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function isPySpace(ch) {
  // U+FEFF is whitespace for JS trim() but not for Python str.strip().
  return ch !== "\uFEFF" && PY_SPACE.test(ch);
}

function pyStrip(s) {
  let a = 0;
  let b = s.length;
  while (a < b && isPySpace(s[a])) a++;
  while (b > a && isPySpace(s[b - 1])) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

function pySplitLines(text) {
  const out = [];
  let start = 0;
  LINE_BREAK.lastIndex = 0;
  let m;
  while ((m = LINE_BREAK.exec(text)) !== null) {
    out.push(text.slice(start, m.index));
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

// str.count(): non-overlapping occurrences.
function countOf(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

// ---------------------------------------------------------------------------
// rules

function scan(text) {
  const hits = [];
  let inFence = false;
  const lines = pySplitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    let line = pyStrip(lines[i]);
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.startsWith("|") || !line) continue;
    // A document may legitimately quote a banned word: `赋能` in backticks is
    // an example, not a claim.
    line = pyStrip(line.replace(/`[^`]*`/g, ""));
    if (!line) continue;
    if (PLACEHOLDER.test(line)) hits.push(["placeholder", n, "unfinished marker"]);
    for (const w of AI_WORDS) if (line.indexOf(w) !== -1) hits.push(["ai-word", n, w]);
    for (const w of ABSOLUTE) if (line.indexOf(w) !== -1) hits.push(["absolute-claim", n, w]);
    if (CLAIMS.test(line) && !DIGIT.test(line)) {
      hits.push(["claim-without-number", n, "verification claim with no figure"]);
    }
    let adverbs = 0;
    for (const w of ADVERBS) adverbs += countOf(line, w);
    if (adverbs >= 2) hits.push(["empty-adverbs", n, `${adverbs} intensifiers in one line`]);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// path discovery (mirrors sorted(Path.rglob("*.md")))

function statOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    return null;
  }
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

function isMd(name) {
  // pathlib glob is case-insensitive on Windows.
  const low = WIN ? name.toLowerCase() : name;
  return low.endsWith(".md");
}

function rglobMd(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    let dirLike = ent.isDirectory();
    let fileLike = ent.isFile();
    if (!dirLike && !fileLike) {
      // A symlink: Path.rglob does not descend into symlinked directories, but
      // does yield symlinked files.
      const st = statOrNull(p);
      if (st) fileLike = st.isFile();
    }
    if (dirLike) out.push(...rglobMd(p));
    else if (fileLike && isMd(ent.name)) out.push(p);
  }
  return out;
}

// Python compares PurePath parts component-wise with normcase (lowercase here).
function pathCmp(a, b) {
  const pa = a.split(/[\\/]+/).filter(Boolean);
  const pb = b.split(/[\\/]+/).filter(Boolean);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const ka = WIN ? pa[i].toLowerCase() : pa[i];
    const kb = WIN ? pb[i].toLowerCase() : pb[i];
    if (ka !== kb) return ka < kb ? -1 : 1;
  }
  return pa.length - pb.length;
}

function targets(args) {
  if (args.length) {
    const out = [];
    for (const a of args) {
      const p = a;
      if (isDir(p)) out.push(...rglobMd(p).sort(pathCmp));
      else if (exists(p)) out.push(p);
    }
    return out;
  }
  const root = process.cwd();
  const found = [path.join(root, "README.md"), path.join(root, "CHANGELOG.md")];
  const docs = path.join(root, "docs");
  if (isDir(docs)) found.push(...rglobMd(docs).sort(pathCmp));
  return found.filter(exists);
}

// str(f.relative_to(ROOT)) if f.is_relative_to(ROOT) else str(f)
function displayPath(p) {
  const root = path.resolve(process.cwd());
  const abs = path.resolve(p);
  const same = (s) => (WIN ? s.toLowerCase() : s);
  const a = same(abs);
  const r = same(root);
  if (a === r) return ".";
  if (a.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) {
    const rel = path.relative(root, abs);
    return rel || ".";
  }
  // Given as a relative path: Python keeps it relative, with native separators.
  return path.normalize(p);
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = "usage: signoff p5 [-h] [--json] [--allow ALLOW] [paths ...]\n";

const HELP =
  "signoff p5 - empty words are a failure\n\n" +
  "positional arguments:\n" +
  "  paths          files or directories (default: README.md CHANGELOG.md docs/)\n\n" +
  "options:\n" +
  "  -h, --help     show this help message and exit\n" +
  "  --json         print one JSON summary line\n" +
  "  --allow rule   rule id to ignore (repeatable)\n";

function run(argv) {
  const args = argv || [];
  const paths = [];
  const allow = [];
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (a === "--json") {
      asJson = true;
      continue;
    }
    if (a === "--allow") {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        process.stderr.write(USAGE);
        process.stderr.write("signoff p5: error: argument --allow: expected one argument\n");
        return 2;
      }
      allow.push(args[++i]);
      continue;
    }
    if (a.startsWith("--allow=")) {
      allow.push(a.slice("--allow=".length));
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      process.stderr.write(USAGE);
      process.stderr.write(`signoff p5: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
    paths.push(a);
  }

  const files = targets(paths);
  const report = [];
  for (const f of files) {
    // errors="replace" in the Python reference == Node's utf8 decoder fallback.
    const text = fs.readFileSync(f).toString("utf8");
    const hits = scan(text).filter((h) => !allow.includes(h[0]));
    const rel = displayPath(f);
    for (const [rule, line, word] of hits) report.push({ file: rel, line, rule, hit: word });
  }

  const ok = report.length === 0;
  const payload = { gate: "p5", ok, files: files.length, hits: report };
  // Same bytes as json.dumps(..., ensure_ascii=False, indent=2) + "\n" under Python's
  // text mode, so `.signoff/p5.json` is byte-identical to the reference.
  const stateFile = core.statePath(process.cwd(), "p5.json");
  fs.writeFileSync(stateFile, (JSON.stringify(payload, null, 2) + "\n").replace(/\n/g, NL), "utf8");
  if (asJson) {
    // json.dumps(..., ensure_ascii=False) keeps ", " / ": " separators; the summary
    // line must be byte-identical to the Python reference.
    process.stdout.write(
      `{"gate": "p5", "ok": ${ok}, "files": ${files.length}, "hits": ${report.length}}${NL}`
    );
  } else {
    const lines = report.map((h) => `[p5] ${h.file}:${h.line}  ${h.rule}  ${h.hit}`);
    lines.push(`[p5] ${ok ? "PASS" : "FAIL"} files=${files.length} hits=${report.length}`);
    process.stdout.write(lines.join(NL) + NL);
  }
  return ok ? 0 : 1;
}

module.exports = { run, scan, targets };

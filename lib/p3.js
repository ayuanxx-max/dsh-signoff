#!/usr/bin/env node
"use strict";
// SignOff gate 3 - parallel work, no collisions.
//
// A task card says what a worker may touch, what proves it done and where the
// rollback point is. `plan` turns a pile of cards into waves: cards whose scopes
// overlap never share a wave. `collect` checks the diff back against the scopes and
// names both kinds of failure - a file nobody owns, and a card that shipped nothing.
//
// This is a line-by-line port of gates/p3_queue.py. Everything observable is meant
// to match the Python gate: subcommands, flags, JSON payloads (and their key order),
// human lines, .signoff/p3.json and exit codes. Two deliberate notes:
//   * the working root is process.cwd() (the Python gate uses Path.cwd()), not the
//     package root that lib/core.js exposes as ROOT;
//   * Python's fnmatch.fnmatch is reimplemented below (it is a shell pattern match
//     where `*` also crosses "/", unlike most glob libraries), including the
//     os.path.normcase case-fold that filenames get on Windows.
// Pure Node >= 18, no Python.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("./core");

const PROG = "signoff p3";
const CHOICES = ["validate", "plan", "collect"];
const REQUIRED = ["id", "goal", "scope", "acceptance", "rollback"];

const USAGE =
  "usage: signoff p3 [-h] [--cards CARDS] [--changed [CHANGED ...]] [--json]\n" +
  "                  {validate,plan,collect}\n";

const HELP =
  USAGE +
  "\npositional arguments:\n" +
  "  {validate,plan,collect}\n" +
  "\noptions:\n" +
  "  -h, --help            show this help message and exit\n" +
  "  --cards CARDS\n" +
  "  --changed [CHANGED ...]\n" +
  "  --json\n";

const WIN = process.platform === "win32";

/* ------------------------------------------------------------------ *
 * Python value semantics (truthiness, str(), repr())
 * ------------------------------------------------------------------ */

// Python `bool(v)`. Differs from JS truthiness for [] / {} (falsy) and NaN (truthy).
function pyTruthy(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

// Python str(v) for the scalar values a card can hold.
function pyStr(v) {
  return typeof v === "string" ? v : pyRepr(v);
}

// Python repr(v), enough for scope entries and duplicate-id messages.
function pyRepr(v) {
  if (v === undefined || v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : String(v);
  if (typeof v === "string") return pyStrRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    return "{" + Object.keys(v).map((k) => pyStrRepr(k) + ": " + pyRepr(v[k])).join(", ") + "}";
  }
  return String(v);
}

function pyStrRepr(s) {
  const quote = s.indexOf("'") !== -1 && s.indexOf('"') === -1 ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote) out += "\\" + ch;
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

// json.dumps(obj, ensure_ascii=False) - the one-line form, which keeps Python's
// default separators (", " and ": "), unlike JSON.stringify.
function jsonLine(obj) {
  process.stdout.write(jsonCompact(obj) + "\n");
}

function jsonCompact(v) {
  if (v === undefined || v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jsonCompact).join(", ") + "]";
  const keys = Object.keys(v);
  return "{" + keys.map((k) => JSON.stringify(k) + ": " + jsonCompact(v[k])).join(", ") + "}";
}

// Python's str ordering (code points) - differs from JS's UTF-16 code-unit order.
function cmpPyStr(a, b) {
  const A = [...a];
  const B = [...b];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i].codePointAt(0);
    const y = B[i].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
}

/* ------------------------------------------------------------------ *
 * fnmatch.fnmatch (Python) - shell pattern, `*` crosses "/"
 * ------------------------------------------------------------------ */

const patternCache = new Map();

function fnmatch(name, pat) {
  // os.path.normcase: on Windows a shell match ignores case (and folds "/" to "\",
  // which our callers have already normalised away).
  if (WIN) {
    name = name.toLowerCase();
    pat = pat.toLowerCase();
  }
  let re = patternCache.get(pat);
  if (!re) {
    if (patternCache.size > 4096) patternCache.clear();
    re = new RegExp("^(?:" + translate(pat) + ")$", "s");
    patternCache.set(pat, re);
  }
  return re.test(name);
}

const RE_SPECIAL = /[\\^$.*+?()[\]{}|]/;

function escapeRe(ch) {
  return RE_SPECIAL.test(ch) ? "\\" + ch : ch;
}

// Mirrors CPython 3.15 Lib/fnmatch.py translate(), minus the newline behaviour
// (the `s` flag) and with set-operator escaping dropped for & ~ | - Python's re
// treats them as literals anyway, and `\&` is only tolerated outside u-mode.
function translate(pat) {
  const out = [];
  const n = pat.length;
  let i = 0;
  while (i < n) {
    const c = pat[i];
    i += 1;
    if (c === "*") {
      out.push(".*");
      while (i < n && pat[i] === "*") i += 1;
    } else if (c === "?") {
      out.push(".");
    } else if (c === "[") {
      const done = translateClass(pat, i);
      out.push(done.src);
      i = done.next;
    } else {
      out.push(escapeRe(c));
    }
  }
  return out.join("");
}

function translateClass(pat, i) {
  const n = pat.length;
  let j = i;
  if (j < n && pat[j] === "!") j += 1;
  if (j < n && pat[j] === "]") j += 1;
  while (j < n && pat[j] !== "]") j += 1;
  if (j >= n) return { src: "\\[", next: i }; // unterminated: "[" is literal
  let stuff = pat.slice(i, j);
  const next = j + 1;
  if (stuff.indexOf("-") === -1) {
    stuff = stuff.replace(/\\/g, "\\\\");
  } else {
    const chunks = [];
    let k = i + (pat[i] === "!" ? 2 : 1);
    let at = i;
    for (;;) {
      const dash = pat.indexOf("-", k);
      if (dash < 0 || dash >= j) break;
      chunks.push(pat.slice(at, dash));
      at = dash + 1;
      k = dash + 3;
    }
    const tail = pat.slice(at, j);
    if (tail) chunks.push(tail);
    else if (chunks.length) chunks[chunks.length - 1] += "-";
    // Drop empty ranges (invalid in a RE), last to first, exactly as CPython does.
    for (let q = chunks.length - 1; q > 0; q--) {
      const prev = chunks[q - 1];
      const cur = chunks[q];
      if (prev.length && cur.length && prev[prev.length - 1] > cur[0]) {
        chunks[q - 1] = prev.slice(0, -1) + cur.slice(1);
        chunks.splice(q, 1);
      }
    }
    stuff = chunks.map((s) => s.replace(/\\/g, "\\\\").replace(/-/g, "\\-")).join("-");
  }
  if (stuff === "") return { src: "(?!)", next }; // empty class: never matches
  if (stuff === "!") return { src: ".", next }; // negated empty class: any char
  if (stuff[0] === "!") stuff = "^" + stuff.slice(1);
  else if (stuff[0] === "^" || stuff[0] === "[") stuff = "\\" + stuff;
  return { src: "[" + stuff + "]", next };
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// pathlib.Path comparison is by parts (drive, components), normcased per platform -
// not by the joined string, which would order "a-b/x" before "a/x".
function pathParts(p) {
  return String(p).split(/[\\/]+/).filter((s) => s.length > 0);
}

function cmpPyPath(a, b) {
  const pa = pathParts(a);
  const pb = pathParts(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = WIN ? pa[i].toLowerCase() : pa[i];
    const y = WIN ? pb[i].toLowerCase() : pb[i];
    const c = cmpPyStr(x, y);
    if (c !== 0) return c;
  }
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
}

// cards_dir.rglob("card.json"): zero or more directories, dotfiles included,
// symlinked directories not followed.
function findCardFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return found;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) found.push(...findCardFiles(full));
    else if (ent.isFile() && ent.name === "card.json") found.push(full);
  }
  return found;
}

function displayPath(file, root) {
  const rel = path.relative(root, file);
  if (rel === "") return ".";
  if (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep)) return rel;
  return file;
}

function jsonErrorText(err) {
  const msg = (err && err.message) || String(err);
  // Python says e.g. "Expecting value: line 1 column 1 (char 0)"; keep the same shape.
  return msg.replace(/^.*?: /, "").replace(/ in JSON at position (\d+)$/, " (char $1)");
}

function loadCards(cardsDir, root) {
  const cards = [];
  const files = isDir(cardsDir) ? findCardFiles(cardsDir) : [];
  files.sort(cmpPyPath);
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      cards.push({ id: f, broken: "unreadable: " + jsonErrorText(e) });
      continue;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      // Python would die on data["_file"] for a non-dict card.
      throw new TypeError(`card is not an object: ${f}`);
    }
    data._file = displayPath(f, root);
    cards.push(data);
  }
  return cards;
}

function validate(cards) {
  const problems = [];
  const seen = new Map();
  for (const c of cards) {
    const cid = Object.prototype.hasOwnProperty.call(c, "id") ? c.id : "?";
    if (pyTruthy(c.broken)) {
      problems.push(`${pyStr(cid)}: ${pyStr(c.broken)}`);
      continue;
    }
    for (const key of REQUIRED) {
      if (!pyTruthy(c[key])) problems.push(`${pyStr(cid)}: missing '${key}'`);
    }
    const scope = c.scope;
    if (Array.isArray(scope)) {
      for (const pat of scope) {
        if (typeof pat !== "string" || !pat.trim()) {
          problems.push(`${pyStr(cid)}: bad scope entry ${pyRepr(pat)}`);
        }
      }
    } else if (Object.prototype.hasOwnProperty.call(c, "scope")) {
      problems.push(`${pyStr(cid)}: scope must be a list`);
    }
    if (seen.has(cid)) {
      problems.push(`duplicate id ${pyStr(cid)} (${pyStr(seen.get(cid))} vs ${pyStr(c._file)})`);
    }
    seen.set(cid, c._file === undefined ? "" : c._file);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Scope matching
 * ------------------------------------------------------------------ */

function asString(v, what) {
  if (typeof v !== "string") {
    throw new TypeError(`${what} must be a string, not ${pyRepr(v)}`);
  }
  return v;
}

// `for pat in card.get("scope") or []` - a bare string iterates its characters,
// and a mapping iterates its keys, exactly like Python.
function scopeItems(card) {
  const scope = card.scope;
  if (!pyTruthy(scope)) return [];
  if (typeof scope === "string") return [...scope];
  if (Array.isArray(scope)) return scope;
  if (typeof scope === "object") return Object.keys(scope);
  throw new TypeError(`${pyStr(scope)} is not iterable`);
}

function prefix(pat) {
  const glob = asString(pat, "scope entry");
  const chars = [...glob];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "*" || chars[i] === "?" || chars[i] === "[") {
      return chars.slice(0, i).join("").replace(/[/\\]+$/, "");
    }
  }
  return glob.replace(/[/\\]+$/, "");
}

function conflicts(a, b) {
  for (const pa of scopeItems(a)) {
    for (const pb of scopeItems(b)) {
      if (pa === pb) return true;
      const fa = prefix(pa).replace(/\\/g, "/");
      const fb = prefix(pb).replace(/\\/g, "/");
      if (!fa || !fb) return true;
      if (fa.startsWith(fb) || fb.startsWith(fa)) return true;
    }
  }
  return false;
}

// Greedy first-fit: a card joins the first wave it collides with nobody in.
function plan(cards) {
  const waves = [];
  for (const card of cards) {
    if (pyTruthy(card.broken)) continue;
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((other) => conflicts(card, other))) {
        wave.push(card);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([card]);
  }
  return waves;
}

function cardOwns(card, file) {
  const target = file.replace(/\\/g, "/");
  for (const raw of scopeItems(card)) {
    const pat = asString(raw, "scope entry").replace(/\\/g, "/");
    if (fnmatch(target, pat) || target === prefix(pat)) return true;
    const pre = prefix(pat);
    if (pre && target.startsWith(pre.replace(/\/+$/, "") + "/")) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * git
 * ------------------------------------------------------------------ */

function splitLines(text) {
  return String(text)
    .split(/\r\n|\r|\n/)
    .map((ln) => ln.trim())
    .filter((ln) => ln.length > 0);
}

function gitChanged(cwd) {
  const files = [];
  const commands = [
    ["diff", "--name-only", "HEAD"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  for (const args of commands) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (r.error) continue;
    if (r.status === 0) files.push(...splitLines(r.stdout || ""));
  }
  return [...new Set(files)].sort(cmpPyStr);
}

/* ------------------------------------------------------------------ *
 * argparse-compatible argument parsing
 * ------------------------------------------------------------------ */

const OPTIONS = [
  { name: "help", flags: ["-h", "--help"] },
  { name: "cards", flags: ["--cards"], value: true },
  { name: "changed", flags: ["--changed"], nargs: "*" },
  { name: "json", flags: ["--json"], storeTrue: true },
];

function knownFlags() {
  const out = [];
  for (const opt of OPTIONS) out.push(...opt.flags);
  return out;
}

function lookupFlag(token) {
  const flags = knownFlags();
  if (flags.includes(token)) return OPTIONS.find((o) => o.flags.includes(token));
  // argparse allows unambiguous prefixes of long options.
  if (token.startsWith("--")) {
    const hits = OPTIONS.filter((o) => o.flags.some((f) => f.startsWith("--") && f.startsWith(token)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const names = hits.map((o) => o.flags.find((f) => f.startsWith("--") && f.startsWith(token)));
      return { ambiguous: names.join(", ") };
    }
  }
  return null;
}

function parseArgs(argv) {
  const state = { cmd: null, extra: [], cards: "tasks", changed: null, json: false, help: false };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (token === "--") {
      // everything after "--" is positional
      for (i += 1; i < argv.length; i++) state.extra.push(String(argv[i]));
      break;
    }
    if (token.length > 1 && token[0] === "-") {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const opt = lookupFlag(name);
      if (!opt) {
        unknown.push(token);
        continue;
      }
      if (opt.ambiguous) return { error: `ambiguous option: ${name} could match ${opt.ambiguous}` };
      if (opt.name === "help") {
        if (inline !== undefined) return { error: "ignored explicit argument '" + inline + "'" };
        state.help = true;
        continue;
      }
      if (opt.storeTrue) {
        if (inline !== undefined) {
          return { error: "ignored explicit argument '" + inline + "'" };
        }
        state[opt.name] = true;
        continue;
      }
      if (opt.name === "cards") {
        if (inline !== undefined) {
          state.cards = inline;
          continue;
        }
        if (i + 1 >= argv.length || String(argv[i + 1]).startsWith("-")) {
          return { error: "argument --cards: expected one argument" };
        }
        state.cards = String(argv[++i]);
        continue;
      }
      if (opt.name === "changed") {
        if (inline !== undefined) {
          state.changed = [inline];
          continue;
        }
        const values = [];
        while (i + 1 < argv.length && !String(argv[i + 1]).startsWith("-")) values.push(String(argv[++i]));
        state.changed = values;
        continue;
      }
    }
    if (state.cmd === null) state.cmd = token;
    else state.extra.push(token);
  }
  if (state.help) return state;
  if (state.cmd === null) return { error: "the following arguments are required: cmd" };
  if (!CHOICES.includes(state.cmd)) {
    const choices = CHOICES.map((c) => `'${c}'`).join(", ");
    return { error: `argument cmd: invalid choice: '${state.cmd}' (choose from ${choices})` };
  }
  if (state.extra.length || unknown.length) {
    return { error: "unrecognized arguments: " + [...state.extra, ...unknown].join(" ") };
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function run(argv) {
  const a = parseArgs(argv || []);
  if (a.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (a.error) {
    process.stderr.write(USAGE + PROG + ": error: " + a.error + "\n");
    return 2;
  }

  const root = process.cwd();
  const stateFile = core.statePath(root, "p3.json");
  const cards = loadCards(path.resolve(root, a.cards), root);
  const problems = validate(cards);

  if (a.cmd === "validate") {
    const ok = problems.length === 0;
    const payload = { gate: "p3", cmd: "validate", ok, cards: cards.length, problems };
    core.writeJSON(stateFile, payload);
    if (a.json) {
      jsonLine({ gate: payload.gate, cmd: payload.cmd, ok: payload.ok, cards: payload.cards });
    } else {
      for (const p of problems) process.stdout.write(`[p3] ${p}\n`);
      process.stdout.write(`[p3] ${ok ? "PASS" : "FAIL"} cards=${cards.length} problems=${problems.length}\n`);
    }
    return ok ? 0 : 1;
  }

  if (a.cmd === "plan") {
    const waves = plan(cards);
    const ok = problems.length === 0 && waves.length > 0;
    const payload = {
      gate: "p3",
      cmd: "plan",
      ok,
      waves: waves.map((w) => w.map((c) => (Object.prototype.hasOwnProperty.call(c, "id") ? c.id : null))),
      problems,
    };
    core.writeJSON(stateFile, payload);
    if (a.json) {
      jsonLine(payload);
    } else {
      waves.forEach((wave, i) => {
        const ids = wave.map((c) => (Object.prototype.hasOwnProperty.call(c, "id") ? pyStr(c.id) : "?"));
        process.stdout.write(`[p3] wave ${i + 1}: ${ids.join(", ")}\n`);
      });
      process.stdout.write(`[p3] ${ok ? "PASS" : "FAIL"} waves=${waves.length} cards=${cards.length}\n`);
    }
    return ok ? 0 : 1;
  }

  const changed = a.changed !== null ? a.changed : gitChanged(root);
  const owners = new Map();
  for (const f of changed) {
    owners.set(
      f,
      cards.filter((c) => !pyTruthy(c.broken) && cardOwns(c, f)).map((c) => c.id)
    );
  }
  const unowned = changed.filter((f) => !owners.get(f).length);
  const missing = cards
    .filter((c) => !pyTruthy(c.broken) && !changed.some((f) => cardOwns(c, f)))
    .map((c) => (Object.prototype.hasOwnProperty.call(c, "id") ? c.id : null));
  const ok = problems.length === 0 && unowned.length === 0;
  const payload = {
    gate: "p3",
    cmd: "collect",
    ok,
    changed: changed.length,
    unowned,
    cardsWithoutChange: missing,
    problems,
  };
  core.writeJSON(stateFile, payload);
  if (a.json) {
    jsonLine({ gate: payload.gate, cmd: payload.cmd, ok: payload.ok, changed: payload.changed });
  } else {
    for (const f of unowned) process.stdout.write(`[p3] unowned change: ${f}\n`);
    for (const cid of missing) process.stdout.write(`[p3] card shipped nothing: ${pyStr(cid)}\n`);
    process.stdout.write(
      `[p3] ${ok ? "PASS" : "FAIL"} changed=${changed.length} unowned=${unowned.length} empty=${missing.length}\n`
    );
  }
  return ok ? 0 : 1;
}

module.exports = { run };

"use strict";
// Gate 4 - risky actions leave a ledger (JavaScript port of gates/p4_ledger.py).
//
// The hash chain is byte-compatible with the Python reference: the digest input is
// `prev + json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`
// encoded as UTF-8, and each appended line is
// `json.dumps(record, ensure_ascii=False, sort_keys=True)` (Python's default
// ", " / ": " separators) + the platform line ending. Python's text mode writes
// CRLF on Windows, so the line ending follows os.EOL, matching the reference file
// byte for byte. Ledgers written by either engine verify under both.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { git, homeDir, sha256 } = require("./core");

const ACTIONS = ["config", "profile", "publish"];
const DECISIONS = ["allow", "deny"];
// The tuple order used by verify(); sort_keys makes the order irrelevant, but keeping
// it mirrors the reference so a reader can diff the two files line by line.
const BODY_KEYS = ["ts", "action", "target", "detail", "rollback", "decision"];
const USAGE = "usage: signoff p4 [-h] {ask,confirm,verify,export} ...";

// Python's text-mode stdout/stderr translate "\n" to os.linesep, so every line the
// reference prints ends with CRLF on Windows and LF elsewhere. Matching that keeps the
// two implementations byte-identical on stdout as well as in the ledger.
function say(line) {
  process.stdout.write(String(line) + os.EOL);
}

function warn(line) {
  process.stderr.write(String(line) + os.EOL);
}

// ---------------------------------------------------------------------------
// Python-compatible JSON

// json.dumps(..., ensure_ascii=False) string escaping: short escapes for \b \f \n \r \t,
// \u00XX (lowercase hex) for the rest of C0, and every non-ASCII character written raw.
function pyStr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else if (c >= 0xd800 && c <= 0xdfff) out += "\\u" + c.toString(16);
    else out += ch;
  }
  return out + '"';
}

// Python renders an int as "12" and a float as "12.0" / "1e-07". JSON.parse gives us a
// single Number type, so ints are printed as ints and non-ints through repr-ish rules.
// A float literal inside an edited ledger body is the one shape where the two engines
// could disagree (JSON.parse has already lost the int/float distinction).
function pyNum(n) {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  const s = String(n);
  const m = /^(-?\d+(?:\.\d+)?)e([+-])(\d+)$/.exec(s);
  if (m) return `${m[1]}e${m[2]}${m[3].padStart(2, "0")}`;
  return s;
}

// opts.compact -> separators=(",", ":"); otherwise Python's default ", " / ": ".
// opts.sortKeys -> sort_keys=True (recursive, like Python).
function dumpsPy(value, opts) {
  const compact = !!(opts && opts.compact);
  const sortKeys = !!(opts && opts.sortKeys);
  const itemSep = compact ? "," : ", ";
  const keySep = compact ? ":" : ": ";
  const enc = (v) => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "string") return pyStr(v);
    if (typeof v === "number") return pyNum(v);
    if (Array.isArray(v)) return "[" + v.map(enc).join(itemSep) + "]";
    const keys = Object.keys(v);
    if (sortKeys) keys.sort();
    return "{" + keys.map((k) => pyStr(k) + keySep + enc(v[k])).join(itemSep) + "}";
  };
  return enc(value);
}

// str() as used by the markdown table: None -> "None", True -> "True".
function pyText(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  return dumpsPy(v);
}

// ---------------------------------------------------------------------------
// Ledger

function has(rec, k) {
  return Object.prototype.hasOwnProperty.call(rec, k);
}

// rec.get(k) in the reference: absent -> None.
function get(rec, k) {
  return has(rec, k) ? rec[k] : null;
}

function homeDirSafe() {
  try {
    return homeDir();
  } catch (e) {
    return process.env.SIGNOFF_HOME || path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), ".signoff");
  }
}

function ledgerPath() {
  return path.join(homeDirSafe(), "audit.log");
}

function ticketsDir() {
  return path.join(homeDirSafe(), "tickets");
}

// Python str.splitlines() boundaries, so a CRLF ledger written on Windows and an LF
// ledger written elsewhere both parse identically.
function splitLines(text) {
  return text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
}

function entries() {
  const log = ledgerPath();
  if (!fs.existsSync(log)) return [];
  const text = fs.readFileSync(log, "utf8");
  const out = [];
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`unreadable ledger line ${out.length + 1}: ${e && e.message}`);
    }
  }
  return out;
}

// The hash chain: sha256(prev + canonical body), UTF-8.
function digest(prev, body) {
  return sha256(String(prev) + dumpsPy(body, { compact: true, sortKeys: true }));
}

function timestamp() {
  const d = new Date();
  const p2 = (n) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = p2(Math.floor(Math.abs(off) / 60));
  const mm = p2(Math.abs(off) % 60);
  // time.strftime("%Y-%m-%dT%H:%M:%S%z") -> 2026-11-06T19:39:01+0800
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${hh}${mm}`
  );
}

function gitDescribe() {
  let r;
  try {
    r = git(["describe", "--tags", "--always"]);
  } catch (e) {
    return "no-git";
  }
  if (!r || r.code !== 0) return "no-git";
  return String(r.out || "").trim();
}

// ---------------------------------------------------------------------------
// Subcommands

function ask(action, target, ttl) {
  const dir = ticketsDir();
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(4).toString("hex");
  const meta = { token: token, action: action, target: target, expires: Date.now() / 1000 + ttl };
  fs.writeFileSync(path.join(dir, token + ".json"), dumpsPy(meta) + os.EOL, "utf8");
  say(`ticket ${token}  action=${action}  target=${target}  ttl=${ttl}s`);
  say(`confirm with: signoff p4 confirm --ticket ${token} --decision allow --detail "..."`);
  return 0;
}

function confirm(ticket, decision, detail, rollback) {
  const p = path.join(ticketsDir(), ticket + ".json");
  if (!fs.existsSync(p)) {
    say(`[p4] unknown or already used ticket ${ticket}`);
    return 2;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    say(`[p4] unreadable ticket ${ticket}`);
    return 2;
  }
  if (!meta || typeof meta !== "object") {
    say(`[p4] unreadable ticket ${ticket}`);
    return 2;
  }
  const expires = has(meta, "expires") ? meta.expires : 0;
  if (expires < Date.now() / 1000) {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      /* missing_ok=True */
    }
    say(`[p4] ticket ${ticket} expired`);
    return 2;
  }
  try {
    fs.unlinkSync(p);
  } catch (e) {
    /* missing_ok=True */
  }

  const chain = entries();
  const prev = chain.length ? get(chain[chain.length - 1], "hash") || "" : "genesis";
  const body = {
    ts: timestamp(),
    action: meta.action,
    target: has(meta, "target") && meta.target !== null ? meta.target : "",
    detail: detail,
    rollback: rollback,
    decision: decision,
  };
  const record = Object.assign({}, body, { prev: prev, hash: digest(prev, body) });
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.appendFileSync(ledgerPath(), dumpsPy(record, { sortKeys: true }) + os.EOL, "utf8");
  say(dumpsPy({ ok: decision === "allow", hash: record.hash, rollback: rollback }));
  return decision === "allow" ? 0 : 1;
}

function verify() {
  const chain = entries();
  const problems = [];
  let prev = "genesis";
  let i = 0;
  for (const rec of chain) {
    i += 1;
    if (!rec || typeof rec !== "object") throw new Error(`unreadable ledger line ${i}: not an object`);
    const body = {};
    for (const k of BODY_KEYS) body[k] = get(rec, k);
    if (get(rec, "prev") !== prev) problems.push(`line ${i}: prev hash mismatch`);
    if (get(rec, "hash") !== digest(prev, body)) {
      problems.push(`line ${i}: content hash mismatch (edited after the fact)`);
    }
    prev = get(rec, "hash") || "";
    const rb = get(rec, "rollback") || "";
    if (!rb) {
      problems.push(`line ${i}: no rollback point recorded`);
    } else if (rb !== "no-git") {
      const ref = pyText(rb);
      if (ref.indexOf(" ") !== -1) {
        problems.push(`line ${i}: rollback point '${ref}' is not a git ref`);
      } else {
        // A missing git binary makes the reference skip the check (subprocess raises
        // OSError); core.git reports that as code 127.
        const r = git(["rev-parse", "--verify", "--quiet", ref]);
        if (r && r.code !== 0 && r.code !== 127) {
          problems.push(`line ${i}: rollback point '${ref}' no longer exists`);
        }
      }
    }
  }
  const ok = problems.length === 0;
  say(dumpsPy({ ok: ok, entries: chain.length, problems: problems }));
  return ok ? 0 : 1;
}

function exportMd(out) {
  const chain = entries();
  const lines = [
    "# SignOff ledger",
    "",
    "| # | action | target | decision | rollback | hash |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  chain.forEach((r, idx) => {
    const row = [
      String(idx + 1),
      pyText(get(r, "action") === null ? "" : get(r, "action")),
      pyText(get(r, "target") === null ? "" : get(r, "target")),
      pyText(get(r, "decision") === null ? "" : get(r, "decision")),
      pyText(get(r, "rollback") === null ? "" : get(r, "rollback")),
      pyText(get(r, "hash") === null ? "" : get(r, "hash")).slice(0, 12),
    ];
    lines.push("| " + row.join(" | ") + " |");
  });
  // Path.write_text creates no directories: the reference fails on a missing parent,
  // so a plain write keeps that behaviour instead of core.writeText's mkdir -p.
  fs.writeFileSync(out, lines.join(os.EOL) + os.EOL, "utf8");
  say(`[p4] ${chain.length} entries written to ${out}`);
  return 0;
}

// ---------------------------------------------------------------------------
// argv

function usageError(msg) {
  warn(USAGE);
  warn(`signoff p4: error: ${msg}`);
  return 2;
}

function flagValue(parsed, key) {
  const v = parsed[key];
  return v === undefined || v === true ? null : v;
}

function parseArgs(argv, spec) {
  const out = Object.assign({}, spec);
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) extra.push(argv[j]);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) {
        out[key] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        out[key] = argv[++i];
      } else {
        out[key] = true;
      }
      continue;
    }
    // `-h` / unknown short flags are handled by main(); anything else is positional.
    if (!a.startsWith("-")) extra.push(a);
    else out._short = a;
  }
  out._extra = extra;
  return out;
}

function parseIntStrict(flag, raw) {
  const s = String(raw).trim();
  if (!/^[+-]?\d+$/.test(s)) {
    throw { usage: `argument ${flag}: invalid int value: '${raw}'` };
  }
  return parseInt(s, 10);
}

function main(argv) {
  if (argv.some((a) => a === "-h" || a === "--help")) {
    say(
      [
        "usage: signoff p4 [-h] {ask,confirm,verify,export} ...",
        "",
        "gate 4  risky actions leave a ledger",
        "",
        "  ask      --action {config,profile,publish} [--target T] [--ttl SEC]",
        "  confirm  --ticket T [--decision {allow,deny}] [--detail D] [--rollback REF]",
        "  verify",
        "  export   [--out FILE]",
      ].join(os.EOL) + os.EOL
    );
    return 0;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd) return usageError("the following arguments are required: cmd");

  try {
    if (cmd === "ask") {
      const p = parseArgs(rest, { action: null, target: "", ttl: 600 });
      if (p._short) return usageError(`unrecognized arguments: ${p._short}`);
      if (p._extra.length) return usageError(`unrecognized arguments: ${p._extra.join(" ")}`);
      const action = flagValue(p, "action");
      if (action === null) return usageError("the following arguments are required: --action");
      if (ACTIONS.indexOf(action) === -1) {
        return usageError(
          `argument --action: invalid choice: '${action}' (choose from ${ACTIONS.map((a) => `'${a}'`).join(", ")})`
        );
      }
      const target = flagValue(p, "target");
      if (target === null) return usageError("argument --target: expected one argument");
      let ttl = p.ttl;
      if (ttl === true) return usageError("argument --ttl: expected one argument");
      if (ttl === null) ttl = 600;
      try {
        ttl = parseIntStrict("--ttl", ttl);
      } catch (e) {
        return usageError(e.usage);
      }
      return ask(action, String(target), ttl);
    }

    if (cmd === "confirm") {
      const p = parseArgs(rest, { ticket: null, decision: "allow", detail: "", rollback: null });
      if (p._short) return usageError(`unrecognized arguments: ${p._short}`);
      if (p._extra.length) return usageError(`unrecognized arguments: ${p._extra.join(" ")}`);
      const ticket = flagValue(p, "ticket");
      if (ticket === null) return usageError("the following arguments are required: --ticket");
      let decision = p.decision;
      if (decision === true) return usageError("argument --decision: expected one argument");
      if (decision === null) decision = "allow";
      if (DECISIONS.indexOf(decision) === -1) {
        return usageError(`argument --decision: invalid choice: '${decision}' (choose from 'allow', 'deny')`);
      }
      const detail = flagValue(p, "detail");
      if (detail === null) return usageError("argument --detail: expected one argument");
      const rollback = flagValue(p, "rollback");
      // `args.rollback or git_describe()`: an empty string falls back just like None.
      return confirm(String(ticket), decision, String(detail), rollback ? rollback : gitDescribe());
    }

    if (cmd === "verify") {
      const p = parseArgs(rest, {});
      if (p._short) return usageError(`unrecognized arguments: ${p._short}`);
      if (p._extra.length) return usageError(`unrecognized arguments: ${p._extra.join(" ")}`);
      return verify();
    }

    if (cmd === "export") {
      const p = parseArgs(rest, { out: "docs/signoff-ledger.md" });
      if (p._short) return usageError(`unrecognized arguments: ${p._short}`);
      if (p._extra.length) return usageError(`unrecognized arguments: ${p._extra.join(" ")}`);
      const out = flagValue(p, "out");
      if (out === null) return usageError("argument --out: expected one argument");
      return exportMd(String(out));
    }
  } catch (e) {
    if (e && e.usage) return usageError(e.usage);
    throw e;
  }

  return usageError(`invalid choice: '${cmd}' (choose from 'ask', 'confirm', 'verify', 'export')`);
}

// argv = the args after the gate name; everything is printed here, the exit code is
// returned to bin/signoff.js.
function run(argv) {
  try {
    return main(argv || []);
  } catch (e) {
    warn(`[p4] ${(e && e.message) || e}`);
    return 1;
  }
}

module.exports = { run, dumpsPy, digest, timestamp, entries, ledgerPath };

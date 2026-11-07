"use strict";
// Secret scanning for the commit gate.
//
// Why this exists: commit hooks that only run tests leave the most expensive
// accident untouched - a key pushed to a public remote. The pattern set below is
// deliberately small and high-signal (a hit is a hit), and the engine is plain
// Node so `npm i -g signoff-cli` needs no extra binary. When gitleaks is on PATH
// it can be used instead (--engine gitleaks|auto) for the full rule set.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("./core");

const USAGE =
  "usage: signoff secrets [-h] [--staged|--all] [--engine auto|builtin|gitleaks] [--allow RULE] [--json] [--quiet]";
const HELP =
  USAGE +
  "\n\n" +
  [
    "options:",
    "  -h, --help     show this help message and exit",
    "  --staged       scan the git index (default)",
    "  --all          scan every tracked text file",
    "  --engine E     auto (default), builtin, or gitleaks when installed",
    "  --allow RULE   rule id to ignore (repeatable)",
    "  --json         print one JSON line",
    "  --quiet        no per-finding lines",
    "  --no-state     do not write .signoff/secrets.json (the machine-wide guard",
    "                 runs in repos that never opted in and must leave no state)",
  ].join("\n") +
  "\n";

const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|vendor|\.venv|venv|__pycache__|target)(\/|$)/;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|go\.sum|Cargo\.lock|composer\.lock|poetry\.lock|\.DS_Store)$/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|bin|wasm|mp3|mp4|mov|avi|wav|woff2?|ttf|otf|eot|class|pyc|o|a)$/i;
const IGNORE_LINE = /signoff-ignore-secret|pragma:\s*allowlist\s*secret/i;

// Placeholder values that look like credentials but are documentation.
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|(?:your|example|sample|dummy|fake|test|change[_-]?me|placeholder|redacted|todo|none|null|undefined|password|passwd|secret|token|apikey|api[_-]?key)[\w.-]*)$/i;

// shannon entropy over the candidate value; random keys score high, words low.
function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const RULES = [
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA)[0-9A-Z]{16}\b/g },
  { id: "aws-secret-key", re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/gi },
  { id: "github-pat", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { id: "gitlab-pat", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai-key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "stripe-live-key", re: /\bsk_live_[A-Za-z0-9]{20,}\b/g },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: "azure-storage-key", re: /AccountKey=[A-Za-z0-9+/=]{80,}/g },
  { id: "discord-webhook", re: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[A-Za-z0-9_-]{20,}/g },
  { id: "db-url-with-password", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s/]{6,}@/gi },
  { id: "generic-credential", re: /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']([^"'\s]{12,})["']/gi, value: 1, entropy: 3.2 },
];

function rule(id) {
  return RULES.find((r) => r.id === id) || null;
}

// One line of text -> findings. Kept pure so tests can call it directly.
function scanText(text, file) {
  const out = [];
  const lines = String(text).split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;
    if (IGNORE_LINE.test(line)) continue;
    for (const r of RULES) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(line)) !== null) {
        if (m[0].length === 0) {
          r.re.lastIndex++;
          continue;
        }
        const value = r.value ? m[r.value] : m[0];
        if (PLACEHOLDER.test(String(value).trim())) continue;
        if (r.entropy && entropy(String(value)) < r.entropy) continue;
        out.push({ file, line: i + 1, rule: r.id, match: mask(String(value)) });
        break; // one hit per rule per line is enough to fail the commit
      }
    }
  }
  return out;
}

// Never print the secret itself: the log is committed-adjacent and often pasted.
function mask(s) {
  const keep = s.length <= 8 ? 2 : 4;
  return s.slice(0, keep) + "…" + s.slice(-2);
}

function readConfig(root) {
  const cfg = core.readJSON(path.join(root, ".signoff", "config.json"), {}) || {};
  return cfg.secrets && typeof cfg.secrets === "object" ? cfg.secrets : {};
}

// Allow entries: "rule", "rule:path/suffix", or {rule, file} objects.
function allowEntries(root) {
  const cfg = readConfig(root);
  const raw = [].concat(cfg.allow || []);
  const fileCfg = core.readJSON(path.join(root, ".signoff", "secrets-allow.json"), []);
  for (const e of [].concat(fileCfg || [])) raw.push(e);
  return raw
    .map((e) => {
      if (typeof e === "string") {
        const i = e.indexOf(":");
        return i === -1 ? { rule: e, file: null } : { rule: e.slice(0, i), file: e.slice(i + 1) };
      }
      if (e && typeof e === "object") return { rule: String(e.rule || ""), file: e.file ? String(e.file) : null };
      return null;
    })
    .filter(Boolean);
}

function allowed(finding, allow) {
  return allow.some((a) => {
    if (a.rule !== finding.rule && a.rule !== "*") return false;
    if (!a.file) return true;
    return finding.file === a.file || finding.file.endsWith(a.file);
  });
}

function skipped(file) {
  return SKIP_DIRS.test(file) || SKIP_FILES.test(file) || BINARY_EXT.test(file);
}

function readMaybe(root, file) {
  const p = path.join(root, file);
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    return null;
  }
}

function stagedFiles(root) {
  const r = core.git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], root);
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function trackedFiles(root) {
  const r = core.git(["ls-files"], root);
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function gitleaksAvailable() {
  const r = spawnSync("gitleaks", ["version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return r.status === 0;
}

// gitleaks writes a JSON report; map it onto our finding shape so the caller does
// not care which engine produced the verdict.
function runGitleaks(root, files) {
  const out = path.join(os.tmpdir(), `signoff-gitleaks-${process.pid}.json`);
  const r = spawnSync(
    "gitleaks",
    ["protect", "--staged", "--redact", "--no-banner", "--report-format", "json", "--report-path", out],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  let raw = [];
  try {
    raw = JSON.parse(fs.readFileSync(out, "utf8"));
  } catch (e) {
    raw = [];
  }
  try {
    fs.unlinkSync(out);
  } catch (e) {
    /* temp file already gone */
  }
  if (r.status === null) return { engine: "gitleaks", error: "gitleaks could not start", findings: [] };
  return {
    engine: "gitleaks",
    findings: (Array.isArray(raw) ? raw : []).map((h) => ({
      file: String(h.File || ""),
      line: Number(h.StartLine || 0),
      rule: String(h.RuleID || "gitleaks"),
      match: String(h.Match ? mask(String(h.Match)) : ""),
    })),
    staged: files,
  };
}

// opts: {mode: "staged"|"all", engine, allow: [rule], quiet, files}
function scan(root, opts) {
  const o = opts || {};
  // An empty --file list means "derive from git", not "scan nothing".
  const given = Array.isArray(o.files) && o.files.length ? o.files : null;
  const files = (given || (o.mode === "all" ? trackedFiles(root) : stagedFiles(root))).filter((f) => !skipped(f));
  const engine = o.engine || "auto";
  if (engine !== "builtin" && (engine === "gitleaks" || gitleaksAvailable())) {
    if (engine === "gitleaks" && !gitleaksAvailable()) {
      return { engine: "gitleaks", available: false, files, findings: [], error: "gitleaks not found on PATH" };
    }
    const res = runGitleaks(root, files);
    const allow = allowEntries(root).concat((o.allow || []).map((r) => ({ rule: r, file: null })));
    res.findings = res.findings.filter((f) => !allowed(f, allow));
    return Object.assign({ available: true }, res);
  }
  const allow = allowEntries(root).concat((o.allow || []).map((r) => ({ rule: r, file: null })));
  const findings = [];
  for (const f of files) {
    const text = readMaybe(root, f);
    if (text === null) continue;
    for (const hit of scanText(text, f)) if (!allowed(hit, allow)) findings.push(hit);
  }
  return { engine: "builtin", available: true, files, findings };
}

function parse(argv) {
  const a = { mode: "staged", engine: "auto", allow: [], json: false, quiet: false, noState: false, help: false, files: [] };
  const take = (i, tok) => {
    const eq = tok.indexOf("=");
    if (eq !== -1) return [tok.slice(eq + 1), i];
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith("--")) return [null, i];
    return [String(argv[i + 1]), i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = String(argv[i]);
    if (tok === "-h" || tok === "--help") {
      a.help = true;
      continue;
    }
    if (tok === "--staged") {
      a.mode = "staged";
      continue;
    }
    if (tok === "--all") {
      a.mode = "all";
      continue;
    }
    if (tok === "--json") {
      a.json = true;
      continue;
    }
    if (tok === "--quiet") {
      a.quiet = true;
      continue;
    }
    if (tok === "--no-state") {
      a.noState = true;
      continue;
    }
    const [v, ni] = take(i, tok);
    if (tok === "--engine" || tok.startsWith("--engine=")) {
      if (v === null) return { error: "argument --engine: expected one argument" };
      i = ni;
      if (!["auto", "builtin", "gitleaks"].includes(v)) return { error: `argument --engine: invalid choice: '${v}'` };
      a.engine = v;
      continue;
    }
    if (tok === "--allow" || tok.startsWith("--allow=")) {
      if (v === null) return { error: "argument --allow: expected one argument" };
      i = ni;
      a.allow.push(v);
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) return { error: `unrecognized arguments: ${tok}` };
    a.files.push(tok);
  }
  return a;
}

function run(argv) {
  const a = parse(argv || []);
  if (a.error) {
    process.stderr.write(USAGE + "\n" + `signoff secrets: error: ${a.error}\n`);
    return 2;
  }
  if (a.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const root = core.git(["rev-parse", "--show-toplevel"]).out || process.cwd();
  const res = scan(root, { mode: a.mode, engine: a.engine, allow: a.allow, files: a.files });
  if (res.error) {
    process.stderr.write(`signoff secrets: ${res.error}\n`);
    return 2;
  }
  const ok = res.findings.length === 0;
  const payload = {
    gate: "secrets",
    ok,
    engine: res.engine,
    mode: a.mode,
    files: res.files.length,
    findings: res.findings,
  };
  if (!a.noState) core.writeJSON(path.join(root, ".signoff", "secrets.json"), payload);
  if (a.json) {
    console.log(JSON.stringify({ gate: "secrets", ok, engine: res.engine, files: res.files.length, hits: res.findings.length }));
  } else {
    if (!a.quiet) {
      for (const f of res.findings) console.log(`[secrets] ${f.file}:${f.line}  ${f.rule}  ${f.match}`);
    }
    // In CI the finding belongs on the diff line, not in a log tail.
    const ci = require("./ci");
    if (!ok && ci.isCI()) {
      ci.annotate(
        res.findings.map((f) => ({
          file: f.file,
          line: f.line,
          rule: f.rule,
          message: `${f.rule} credential pattern (${f.match}); remove it or allow the rule in .signoff/config.json`,
        }))
      );
      ci.summary(`### SignOff: ${res.findings.length} secret(s) in the change\n\n` + ci.table(res.findings.map((f) => [f.file, String(f.line), f.rule]), ["file", "line", "rule"]));
    }
    console.log(`[secrets] ${ok ? "PASS" : "FAIL"} engine=${res.engine} files=${res.files.length} hits=${res.findings.length}`);
  }
  return ok ? 0 : 1;
}

module.exports = { run, scan, scanText, RULES, USAGE, HELP, mask };

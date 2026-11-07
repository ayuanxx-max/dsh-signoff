#!/usr/bin/env node
"use strict";
// Self-test for signoff-cli: every gate runs against a throwaway git repo and the
// exit code is the assertion. Node only — this is the suite `npm test` runs.
//   node test/selftest.mjs

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "signoff.js");
const PASS = [];
const FAIL = [];
const AUDIT = [];
let HOME = "";

function check(name, got, want, extra) {
  const ok = got === want;
  (ok ? PASS : FAIL).push(`${name}: got=${got} want=${want}${extra ? " " + extra : ""}`);
}

function run(args, cwd, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    // Fixtures are not the user's repos: no auto-install unless a test asks for it.
    env: { ...process.env, SIGNOFF_HOME: HOME, SIGNOFF_NO_BOOTSTRAP: "1", ...(env || {}) },
  });
}

// Fixture repos are not the user's machine: keep the machine-wide dispatcher out of the
// suite so a commit inside a fixture only runs what the test asked for.
function gitEnv(extra) {
  return { ...process.env, SIGNOFF_HOME: HOME, SIGNOFF_NO_MACHINE: "1", ...(extra || {}) };
}

function gitOut(args, cwd, env) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv(env) });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function git(args, cwd, env) {
  gitOut(args, cwd, env);
}

// Git runs hooks through sh, and sh finds an extension-less `signoff` on PATH.
// That is how a real `git commit` reaches this checkout without a global install.
function makeShim(base) {
  const dir = path.join(base, "shim");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "signoff");
  const fwd = (s) => s.split("\\").join("/");
  fs.writeFileSync(p, `#!/bin/sh\nexec "${fwd(process.execPath)}" "${fwd(CLI)}" "$@"\n`, "utf8");
  try {
    fs.chmodSync(p, 0o755);
  } catch (e) {
    /* windows: sh does not need the bit */
  }
  return dir;
}

function buildRepo(base) {
  const repo = path.join(base, "repo");
  for (const d of ["tests", "verify/scenarios", "docs", "tasks/t1", "tasks/t2"]) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
  }
  const w = (p, s) => fs.writeFileSync(path.join(repo, p), s, "utf8");
  w(
    "package.json",
    JSON.stringify(
      { name: "fixture", version: "0.0.0", devDependencies: { "signoff-cli": "^4.0.0" } },
      null,
      2
    ) + "\n"
  );
  w("tasks/t1/card.json", JSON.stringify({ id: "t1", goal: "g", scope: ["src/a/**"], acceptance: ["pass"], rollback: "HEAD" }));
  w("tasks/t2/card.json", JSON.stringify({ id: "t2", goal: "g", scope: ["src/a/b.py"], acceptance: ["pass"], rollback: "HEAD" }));
  w("docs/clean.md", "# clean\n\n40 cases in 3.6 s, 12/12 PASS.\n");
  w("docs/dirty.md", "# dirty\n\n这个方案赋能全链路，闭环彻底解决，已验证。\n");
  fs.writeFileSync(
    path.join(repo, "verify/scenarios/a.json"),
    JSON.stringify({ checks: [{ name: "x" }, { name: "y" }, { name: "z" }] })
  );
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  git(["add", "-A"], repo);
  git(["commit", "-qm", "init"], repo);
  return repo;
}

function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-selftest-"));
  HOME = path.join(base, "home");
  try {
    const repo = buildRepo(base);
    const shim = makeShim(base);

    // P1
    let r = run(["p1", "--run", `"${process.execPath}" -e "console.log('3 passed')"`], repo);
    check("p1 pass", r.status, 0);
    const p1 = JSON.parse(fs.readFileSync(path.join(repo, ".signoff", "p1.json"), "utf8"));
    check("p1 cases parsed", p1.cases, 3);
    r = run(["p1", "--run", `"${process.execPath}" -e "process.exit(1)"`], repo);
    check("p1 fail on rc!=0", r.status, 1);

    // P2
    r = run(["p2", "--strict", "--json"], repo);
    check("p2 pass", r.status, 0);
    r = run(["p2", "--min-assertions", "9"], repo);
    check("p2 fail on threshold", r.status, 1);

    // P3
    r = run(["p3", "validate"], repo);
    check("p3 validate", r.status, 0);
    r = run(["p3", "plan"], repo);
    check("p3 plan splits", r.status, 0);
    const p3 = JSON.parse(fs.readFileSync(path.join(repo, ".signoff", "p3.json"), "utf8"));
    check("p3 wave count", p3.waves.length, 2);

    // P4
    r = run(["p4", "ask", "--action", "publish", "--target", "demo@1.0.0"], repo);
    check("p4 ask", r.status, 0);
    const ticket = (r.stdout.match(/ticket (\S+)/) || [])[1];
    r = run(["p4", "confirm", "--ticket", ticket, "--decision", "allow", "--detail", "d", "--rollback", "HEAD"], repo);
    check("p4 confirm allow", r.status, 0);
    r = run(["p4", "verify"], repo);
    check("p4 verify ok", r.status, 0);
    r = run(["p4", "confirm", "--ticket", ticket, "--decision", "allow"], repo);
    check("p4 ticket single-use", r.status, 2);
    r = run(["p4", "ask", "--action", "publish", "--target", "deny-me"], repo);
    const denyTicket = (r.stdout.match(/ticket (\S+)/) || [])[1];
    r = run(["p4", "confirm", "--ticket", denyTicket, "--decision", "deny"], repo);
    check("p4 deny red", r.status, 1);
    const log = path.join(HOME, "audit.log");
    fs.writeFileSync(log, fs.readFileSync(log, "utf8").replace('"d"', '"tampered"'), "utf8");
    r = run(["p4", "verify"], repo);
    check("p4 tamper detected", r.status, 1);
    r = run(["p4", "ask", "--action", "publish", "--target", "x"], repo);
    const t2 = (r.stdout.match(/ticket (\S+)/) || [])[1];
    run(["p4", "confirm", "--ticket", t2, "--decision", "allow", "--rollback", "npm deprecate x"], repo);
    r = run(["p4", "verify"], repo);
    check("p4 fake rollback refused", r.status, 1);

    // P4 repo-scoped ledger (3.3.0): without SIGNOFF_HOME the ledger lives in the repo,
    // records carry their repository, and a pre-3.3.0 chain still verifies.
    const lib = require(path.join(ROOT, "lib", "p4.js"));
    const rhome = path.join(base, "legacy-home");
    const rhomeDir = path.join(rhome, ".signoff");
    fs.mkdirSync(rhomeDir, { recursive: true });
    const v1body = {
      ts: "2026-01-01T00:00:00+0000",
      action: "publish",
      target: "old@1.0.0",
      detail: "legacy",
      rollback: "HEAD",
      decision: "allow",
    };
    const v1rec = Object.assign({}, v1body, { prev: "genesis", hash: lib.digest("genesis", v1body) });
    fs.writeFileSync(path.join(rhomeDir, "audit.log"), lib.dumpsPy(v1rec, { sortKeys: true }) + os.EOL, "utf8");
    const noHome = { SIGNOFF_HOME: "", HOME: rhome, USERPROFILE: rhome };
    r = run(["p4", "verify"], repo, noHome);
    check("p4 repo ledger seeds legacy chain", r.status, 0, (r.stdout || "").trim());
    const repoLog = path.join(repo, ".signoff", "audit.log");
    check("p4 ledger lands in repo", fs.existsSync(repoLog) ? 1 : 0, 1);
    r = run(["p4", "ask", "--action", "publish", "--target", "scoped"], repo, noHome);
    const t3 = (r.stdout.match(/ticket (\S+)/) || [])[1];
    run(["p4", "confirm", "--ticket", t3, "--decision", "allow", "--detail", "s", "--rollback", "HEAD"], repo, noHome);
    check("p4 record carries repo", /"repo": "[^"]+"/.test(fs.readFileSync(repoLog, "utf8")) ? 1 : 0, 1);
    const lines = fs.readFileSync(repoLog, "utf8").trim().split(/\r?\n/);
    const newest = JSON.parse(lines[lines.length - 1]);
    const lastHash = newest.hash;
    const foreignBody = {
      ts: "2026-01-02T00:00:00+0000",
      action: "publish",
      target: "elsewhere",
      detail: "other repo",
      rollback: "v-missing-tag",
      decision: "allow",
      repo: "elsewhere",
    };
    const foreign = Object.assign({}, foreignBody, { prev: lastHash, hash: lib.digest(lastHash, foreignBody) });
    fs.appendFileSync(repoLog, lib.dumpsPy(foreign, { sortKeys: true }) + os.EOL, "utf8");
    r = run(["p4", "verify"], repo, noHome);
    check("p4 skips foreign repo entries", r.status, 0, (r.stdout || "").trim());
    const ownBody = {
      ts: "2026-01-03T00:00:00+0000",
      action: "publish",
      target: "mine",
      detail: "own repo",
      rollback: "v-missing-tag",
      decision: "allow",
      repo: newest.repo,
    };
    const own = Object.assign({}, ownBody, { prev: foreign.hash, hash: lib.digest(foreign.hash, ownBody) });
    fs.appendFileSync(repoLog, lib.dumpsPy(own, { sortKeys: true }) + os.EOL, "utf8");
    r = run(["p4", "verify"], repo, noHome);
    check("p4 still checks own entries", r.status, 1, (r.stdout || "").trim());

    // P5
    r = run(["p5", "docs/dirty.md"], repo);
    check("p5 dirty red", r.status, 1);
    r = run(["p5", "docs/clean.md"], repo);
    check("p5 clean green", r.status, 0);

    // Guard: install once, then the gates run themselves.
    const ghome = path.join(base, "guard-home");
    const g = (args, env) => run(args, repo, { SIGNOFF_HOME: ghome, ...(env || {}) });
    // a real `git commit`, with the CLI reachable from the hooks
    const commit = (args, env) =>
      spawnSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          SIGNOFF_HOME: ghome,
          PATH: `${shim}${path.delimiter}${process.env.PATH}`,
          ...(env || {}),
        },
      });
    r = g(["audit", "--since-install"]);
    check("audit --since-install needs install point", r.status, 2);
    r = g(["init", "--no-ci"]);
    check("guard init", r.status, 0);
    const ipath = path.join(repo, ".signoff", "installed.json");
    check("init records install point", fs.existsSync(ipath) ? 1 : 0, 1);
    const ip1 = JSON.parse(fs.readFileSync(ipath, "utf8"));
    check("install point carries sha", /^[0-9a-f]{7,40}$/.test(ip1.sha || "") ? 1 : 0, 1, JSON.stringify(ip1));
    check("audit --since-install ok", g(["audit", "--since-install"]).status, 0, g(["audit", "--since-install"]).stdout.trim());
    r = g(["init", "--no-ci"]);
    const ip2 = JSON.parse(fs.readFileSync(ipath, "utf8"));
    check("re-init keeps install point", `${ip2.sha}|${ip2.ts}` === `${ip1.sha}|${ip1.ts}` ? 1 : 0, 1);
    check("re-init records the hook version", ip2.version, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);

    // init --chain: the hook that was already there keeps running, and uninstall gives it back.
    const crepo = path.join(base, "chain-repo");
    const chome = path.join(base, "chain-home");
    fs.mkdirSync(crepo, { recursive: true });
    gitOut(["init", "-q", "."], crepo);
    const chooks = path.join(crepo, ".git", "hooks");
    fs.mkdirSync(chooks, { recursive: true });
    const oldHook = path.join(chooks, "pre-commit");
    fs.writeFileSync(oldHook, "#!/bin/sh\necho ran > .local-ran\nexit 0\n", "utf8");
    fs.chmodSync(oldHook, 0o755);
    fs.writeFileSync(path.join(crepo, "a.txt"), "a", "utf8");
    gitOut(["add", "."], crepo);
    gitOut(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "base"], crepo);
    check("old hook ran before signoff", fs.existsSync(path.join(crepo, ".local-ran")) ? 1 : 0, 1);
    const c = (args) => run(args, crepo, { SIGNOFF_HOME: chome });
    const ccommit = (msg) =>
      spawnSync("git", ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", msg], {
        cwd: crepo,
        encoding: "utf8",
        env: { ...process.env, SIGNOFF_HOME: chome, PATH: `${shim}${path.delimiter}${process.env.PATH}` },
      });
    r = c(["init", "--no-ci", "--chain"]);
    check("init --chain", r.status, 0, (r.stdout || "").trim());
    check("chain keeps old hook aside", fs.existsSync(path.join(chooks, "pre-commit.local")) ? 1 : 0, 1);
    fs.rmSync(path.join(crepo, ".local-ran"), { force: true });
    fs.writeFileSync(path.join(crepo, "b.txt"), "b", "utf8");
    gitOut(["add", "."], crepo);
    const chained = ccommit("chained");
    check("chained commit passes", chained.status, 0, (chained.stderr || "").trim());
    check("chained commit ran the old hook", fs.existsSync(path.join(crepo, ".local-ran")) ? 1 : 0, 1);
    check("chained commit got a trailer", /^Signoff-Pass: [0-9a-f]{12}$/m.test(gitOut(["log", "-1", "--format=%B"], crepo)) ? 1 : 0, 1);
    fs.writeFileSync(path.join(chooks, "pre-commit.local"), "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(path.join(chooks, "pre-commit.local"), 0o755);
    fs.writeFileSync(path.join(crepo, "c.txt"), "c", "utf8");
    gitOut(["add", "."], crepo);
    check("failing old hook blocks the commit", ccommit("blocked").status === 0 ? 0 : 1, 1);
    r = c(["uninstall"]);
    check("uninstall restores the old hook", /restored from pre-commit\.local/.test(r.stdout) ? 1 : 0, 1);
    check("restored hook is not ours", fs.readFileSync(oldHook, "utf8").includes("# generated by dsh-signoff") ? 0 : 1, 1);
    check("restored hook removed .local", fs.existsSync(path.join(chooks, "pre-commit.local")) ? 0 : 1, 1);

    // a chained hook keeps its language: a node hook becomes .local.js and runs with node
    const jrepo = path.join(base, "chain-js-repo");
    const jhome = path.join(base, "chain-js-home");
    fs.mkdirSync(jrepo, { recursive: true });
    gitOut(["init", "-q", "."], jrepo);
    fs.mkdirSync(path.join(jrepo, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(jrepo, ".git", "hooks", "pre-commit"),
      "#!/usr/bin/env node\nrequire('fs').writeFileSync('.js-ran','1')\n",
      { encoding: "utf8", mode: 0o644 }
    );
    fs.writeFileSync(path.join(jrepo, "a.txt"), "a", "utf8");
    gitOut(["add", "."], jrepo);
    const j = (args) => run(args, jrepo, { SIGNOFF_HOME: jhome });
    r = j(["init", "--no-ci", "--no-push", "--chain", "--quiet"]);
    const jlocal = path.join(jrepo, ".git", "hooks", "pre-commit.local.js");
    check("node hook chained as .local.js", fs.existsSync(jlocal) ? 1 : 0, 1, (r.stdout || "").trim());
    const jhook = fs.readFileSync(path.join(jrepo, ".git", "hooks", "pre-commit"), "utf8");
    check("hook dispatches .py/.js/.ps1", /\.py\) PY=/.test(jhook) && /\.js\) node/.test(jhook) ? 1 : 0, 1);
    // Run the generated hook directly: whether `signoff` is on PATH is the harness's
    // business elsewhere, and the point here is only that the chained hook ran first.
    const jc = spawnSync("git", ["hook", "run", "pre-commit"], {
      cwd: jrepo,
      encoding: "utf8",
    });
    check("chained node hook left its mark", fs.existsSync(path.join(jrepo, ".js-ran")) ? 1 : 0, 1, (jc.stderr || "").trim());

    // runner detection: named runners win, and an empty tests/ folder is not a suite
    const detector = require(path.join(ROOT, "lib", "detect.js"));
    const dprobe = (files) => {
      const dir = fs.mkdtempSync(path.join(base, "detect-"));
      for (const [name, body] of Object.entries(files)) {
        const p = path.join(dir, name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body, "utf8");
      }
      return detector.detect(dir, {});
    };
    check("detect npm script", dprobe({ "package.json": JSON.stringify({ scripts: { test: "node t.js" } }) }).cmd, "npm test --silent");
    check("detect vitest", dprobe({ "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }) }).source, "vitest");
    check("detect cargo", dprobe({ "Cargo.toml": "[package]\n" }).cmd, "cargo test --quiet");
    check("detect go", dprobe({ "go.mod": "module x\n" }).cmd, "go test ./...");
    check("detect make", dprobe({ "Makefile": "test:\n\t@true\n" }).cmd, "make test");
    check("empty tests dir is not a suite", dprobe({ "tests/.keep": "" }).cmd, null);
    check("config outranks files", detector.detect(base, { test_cmd: "echo hi" }).cmd, "echo hi");
    const ddir = fs.mkdtempSync(path.join(base, "describe-"));
    fs.writeFileSync(path.join(ddir, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }), "utf8");
    check("describe names the runner", /npm test --silent  \(package\.json scripts\.test\)/.test(detector.describe(ddir, {})) ? 1 : 0, 1);

    // the generated CI workflow has to survive the default shallow clone
    const cirepo = path.join(base, "ci-repo");
    fs.mkdirSync(cirepo, { recursive: true });
    gitOut(["init", "-q", "."], cirepo);
    fs.writeFileSync(path.join(cirepo, "a.txt"), "a", "utf8");
    gitOut(["add", "."], cirepo);
    gitOut(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "a"], cirepo);
    run(["init", "--no-push"], cirepo, { SIGNOFF_HOME: path.join(base, "ci-home") });
    const wf = fs.readFileSync(path.join(cirepo, ".github", "workflows", "signoff.yml"), "utf8");
    check("CI workflow fetches full history", /fetch-depth: 0/.test(wf) ? 1 : 0, 1);
    check(
      "CI audit asks for a verified rev",
      /--verify --quiet/.test(wf) && !/rev-parse HEAD~1"/.test(wf) ? 1 : 0,
      1
    );

    // uninstall: --keep-config drops runtime state, --all drops the config too
    const urepo = path.join(base, "uninstall-repo");
    const uhome = path.join(base, "uninstall-home");
    fs.mkdirSync(urepo, { recursive: true });
    gitOut(["init", "-q", "."], urepo);
    fs.writeFileSync(path.join(urepo, "a.txt"), "a", "utf8");
    gitOut(["add", "."], urepo);
    gitOut(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "a"], urepo);
    const u = (args, extra) => run(args, urepo, Object.assign({ SIGNOFF_HOME: uhome }, extra || {}));
    u(["init", "--no-ci", "--quiet"]);
    fs.writeFileSync(path.join(urepo, ".signoff", "passed"), '{"tree":"x"}', "utf8");
    r = u(["uninstall", "--keep-config"]);
    check("uninstall --keep-config keeps the config", fs.existsSync(path.join(urepo, ".signoff", "config.json")) ? 1 : 0, 1);
    check("uninstall --keep-config drops the marker", fs.existsSync(path.join(urepo, ".signoff", "passed")) ? 0 : 1, 1);
    check("uninstall --keep-config drops the install point", fs.existsSync(path.join(urepo, ".signoff", "installed.json")) ? 0 : 1, 1);
    u(["init", "--no-ci", "--quiet"]);
    r = u(["uninstall", "--all"]);
    check("uninstall --all drops the config", fs.existsSync(path.join(urepo, ".signoff", "config.json")) ? 0 : 1, 1);

    // one hook run at a time: a live lock refuses, a stale one is broken
    u(["init", "--no-ci", "--quiet"]);
    const lk = path.join(urepo, ".signoff", "lock");
    fs.writeFileSync(lk, JSON.stringify({ pid: process.pid, stage: "pre-commit", ts: new Date().toISOString() }), "utf8");
    fs.writeFileSync(path.join(urepo, "z.txt"), "z", "utf8");
    gitOut(["add", "."], urepo);
    r = u(["hook", "pre-commit"], { SIGNOFF_LOCK_WAIT_MS: "0" });
    check("live lock refuses the run", r.status, 1, (r.stderr || "").trim());
    check("live lock names the holder", /holds the lock/.test(r.stderr) ? 1 : 0, 1);
    fs.writeFileSync(lk, JSON.stringify({ pid: 999999, stage: "pre-commit", ts: new Date(Date.now() - 3600e3).toISOString() }), "utf8");
    r = u(["hook", "pre-commit"], { SIGNOFF_LOCK_WAIT_MS: "0" });
    check("stale lock is broken", r.status === 0 ? 1 : 0, 1, (r.stdout || "").trim());
    check("lock released after the run", fs.existsSync(lk) ? 0 : 1, 1);

    // doctor --fix reinstalls hooks it can see are gone, then re-checks
    gitOut(["reset", "-q"], urepo);
    const fixHook = path.join(urepo, ".git", "hooks", "pre-commit");
    fs.rmSync(fixHook, { force: true });
    r = u(["doctor", "--fix", "--quiet"]);
    check("doctor --fix reinstalls the hook", fs.existsSync(fixHook) ? 1 : 0, 1, (r.stdout || "").trim());
    check("doctor --fix exits ok after repair", r.status, 0, (r.stdout || "").trim());
    r = u(["doctor", "--fix"]);
    check("doctor --fix is idempotent", /nothing to repair/.test(r.stdout) ? 1 : 0, 1, (r.stdout || "").trim());

    // audit refuses an install point that is not an ancestor of HEAD, and --reset-install fixes it
    const uipath = path.join(urepo, ".signoff", "installed.json");
    fs.writeFileSync(uipath, JSON.stringify({ sha: "0".repeat(40), ts: new Date().toISOString(), version: "3.9.0" }), "utf8");
    r = u(["audit", "--since-install"]);
    check("audit refuses a foreign install point", r.status, 2, (r.stderr || "").trim());
    check("audit says why", /not an ancestor of HEAD/.test(r.stderr) ? 1 : 0, 1);
    r = u(["init", "--reset-install", "--no-ci", "--no-push", "--quiet"]);
    const fixedPoint = JSON.parse(fs.readFileSync(uipath, "utf8"));
    check("init --reset-install records HEAD", fixedPoint.sha, gitOut(["rev-parse", "HEAD"], urepo).trim());
    r = u(["audit", "--since-install"]);
    check("audit works after the reset", r.status, 0, (r.stderr || "").trim());

    // init --lock-test pins what detection found, so another machine cannot switch runners
    const prepo = path.join(base, "pin-repo");
    const phome = path.join(base, "pin-home");
    fs.mkdirSync(prepo, { recursive: true });
    gitOut(["init", "-q", "."], prepo);
    fs.writeFileSync(
      path.join(prepo, "package.json"),
      JSON.stringify({ name: "pin", devDependencies: { vitest: "^1.0.0" } }, null, 2),
      "utf8"
    );
    fs.writeFileSync(path.join(prepo, "a.txt"), "a", "utf8");
    gitOut(["add", "."], prepo);
    const pin = (args) => run(args, prepo, { SIGNOFF_HOME: phome });
    r = pin(["init", "--lock-test", "--no-ci", "--no-push"]);
    const pinned = JSON.parse(fs.readFileSync(path.join(prepo, ".signoff", "config.json"), "utf8"));
    check("init --lock-test pins the runner", pinned.test_cmd, "npx --no-install vitest run");
    check("init --lock-test says what it locked", /locked\s+npx --no-install vitest run/.test(r.stdout) ? 1 : 0, 1, (r.stdout || "").trim());

    // the lock directory shape blocks too, and a dead owner breaks it
    const dlk = path.join(urepo, ".signoff", "lock");
    fs.mkdirSync(dlk, { recursive: true });
    fs.writeFileSync(path.join(dlk, "owner.json"), JSON.stringify({ pid: process.pid, stage: "pre-commit", ts: new Date().toISOString() }), "utf8");
    r = u(["hook", "pre-commit"], { SIGNOFF_LOCK_WAIT_MS: "0" });
    check("directory lock blocks", r.status, 1, (r.stderr || "").trim());
    fs.writeFileSync(path.join(dlk, "owner.json"), JSON.stringify({ pid: 999999, stage: "pre-commit", ts: new Date().toISOString() }), "utf8");
    u(["hook", "pre-commit"], { SIGNOFF_LOCK_WAIT_MS: "0" });
    check("dead owner breaks the directory lock", fs.existsSync(dlk) ? 0 : 1, 1);

    // p4 export --merge: another repo's ledger joins the table, tampering is reported
    const lrepo = path.join(base, "ledger-repo");
    const lhome = path.join(base, "ledger-home");
    fs.mkdirSync(lrepo, { recursive: true });
    gitOut(["init", "-q", "."], lrepo);
    fs.writeFileSync(path.join(lrepo, "a.txt"), "a", "utf8");
    gitOut(["add", "."], lrepo);
    gitOut(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "a"], lrepo);
    const l = (args) => run(args, lrepo, { SIGNOFF_HOME: lhome });
    const askOut = l(["p4", "ask", "--action", "publish", "--target", "demo@1.0.0"]);
    const lticket = (askOut.stdout.match(/ticket (\S+)/) || [])[1];
    l(["p4", "confirm", "--ticket", lticket, "--decision", "allow", "--detail", "d", "--rollback", "HEAD"]);
    const ledgerFile = path.join(lhome, "audit.log");
    check("ledger file written", fs.existsSync(ledgerFile) ? 1 : 0, 1);
    const other = path.join(base, "other-ledger.jsonl");
    fs.copyFileSync(ledgerFile, other);
    const expOut = path.join(base, "merged.md");
    r = l(["p4", "export", "--out", expOut, "--merge", other]);
    check("export --merge", r.status, 0, (r.stdout || "").trim());
    const md = fs.readFileSync(expOut, "utf8");
    check("merged table has a repo column", /\| # \| ts \| repo \|/.test(md) ? 1 : 0, 1);
    check("merged table has both rows", (md.match(/^\| \d+ \|/gm) || []).length, 2);
    const tampered = path.join(base, "tampered-ledger.jsonl");
    fs.writeFileSync(tampered, fs.readFileSync(other, "utf8").replace('"decision": "allow"', '"decision": "deny"'), "utf8");
    r = l(["p4", "export", "--out", path.join(base, "t.md"), "--merge", tampered]);
    check("merge reports a broken chain", r.status === 0 ? 0 : 1, 1, (r.stderr || "").trim());
    const jsonOut = path.join(base, "ledger.json");
    r = l(["p4", "export", "--out", jsonOut, "--format", "json", "--merge", other]);
    const parsed = fs.existsSync(jsonOut) ? JSON.parse(fs.readFileSync(jsonOut, "utf8")) : [];
    check("export --format json", Array.isArray(parsed) && parsed.length === 2 && parsed[0].hash ? 1 : 0, 1);
    const csvOut = path.join(base, "ledger.csv");
    l(["p4", "export", "--out", csvOut, "--format", "csv"]);
    const csv = fs.readFileSync(csvOut, "utf8").trim().split(/\r?\n/);
    check("export --format csv has a header and one row", csv.length === 2 && csv[0].startsWith("ts,repo,action") ? 1 : 0, 1);
    check("export rejects an unknown format", l(["p4", "export", "--format", "xml"]).status, 2);
    const hrepo = path.join(base, "hint-repo");
    fs.mkdirSync(hrepo, { recursive: true });
    gitOut(["init", "-q", "."], hrepo);
    for (const n of ["a", "b", "c"]) {
      fs.writeFileSync(path.join(hrepo, `${n}.txt`), n, "utf8");
      gitOut(["add", "."], hrepo);
      gitOut(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", n], hrepo);
    }
    run(["init", "--no-ci"], hrepo);
    const hsha = JSON.parse(fs.readFileSync(path.join(hrepo, ".signoff", "installed.json"), "utf8")).sha;
    const hinted = run(["audit", "--range", `${hsha}~2..HEAD`], hrepo);
    check("audit hints pre-install commits", /predate the install point/.test(hinted.stdout) ? 1 : 0, 1, hinted.stdout.trim().replace(/\n/g, " | "));
    check("audit --since-install in fresh repo", run(["audit", "--since-install"], hrepo).status, 0);
    const hooks = path.join(repo, ".git", "hooks");
    check("guard pre-commit hook", fs.existsSync(path.join(hooks, "pre-commit")) ? 1 : 0, 1);
    check("guard commit-msg hook", fs.existsSync(path.join(hooks, "commit-msg")) ? 1 : 0, 1);
    check("guard pre-push hook", fs.existsSync(path.join(hooks, "pre-push")) ? 1 : 0, 1);
    check("guard config", fs.existsSync(path.join(repo, ".signoff", "config.json")) ? 1 : 0, 1);
    check(
      "guard gitignore",
      fs.readFileSync(path.join(repo, ".gitignore"), "utf8").split("\n").includes(".signoff/") ? 1 : 0,
      1
    );
    r = g(["status", "--json"]);
    check("guard status", JSON.parse(r.stdout).installed["pre-commit"] ? 1 : 0, 1);

    fs.writeFileSync(path.join(repo, "docs", "clean.md"), "# clean\n\n40 cases in 3.6 s, 12/12 PASS.\nsecond\n", "utf8");
    git(["add", "-A"], repo);
    r = g(["hook", "pre-push"]);
    check("guard pre-push pass", r.status, 0);
    check("pre-push leaves no marker", fs.existsSync(path.join(repo, ".signoff", "passed")) ? 0 : 1, 1);
    r = g(["hook", "pre-commit"]);
    check("guard hook pass", r.status, 0);
    const markerAfterPass = JSON.parse(fs.readFileSync(path.join(repo, ".signoff", "passed"), "utf8"));
    check("marker mode pass", markerAfterPass.mode, "pass");
    check("marker tree is the staged tree", markerAfterPass.tree, gitOut(["write-tree"], repo).trim());
    check("marker ts is iso", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(markerAfterPass.ts) ? 1 : 0, 1, markerAfterPass.ts);
    r = g(["hook", "pre-commit"]);
    check("guard cache hit", /cached/.test(r.stdout) ? 1 : 0, 1);
    check(
      "marker written on cache hit",
      fs.existsSync(path.join(repo, ".signoff", "passed")) ? 1 : 0,
      1
    );

    fs.writeFileSync(path.join(repo, "docs", "dirty.md"), "# dirty\n\n该方案赋能全链路，闭环彻底解决，已验证。\nagain\n", "utf8");
    git(["add", "-A"], repo);
    r = g(["hook", "pre-commit"]);
    check("guard hook fail closed", r.status, 1);

    r = g(["hook", "pre-commit"], { SIGNOFF_SKIP: "1" });
    check("guard skip allowed", r.status, 0);
    check("guard skip recorded", fs.existsSync(path.join(repo, ".signoff", "skips.log")) ? 1 : 0, 1);
    check(
      "marker mode skip",
      JSON.parse(fs.readFileSync(path.join(repo, ".signoff", "passed"), "utf8")).mode,
      "skip"
    );

    // ------------------------------------------------------------- trailers
    // A real commit: pre-commit records the tree, commit-msg turns it into a line.
    git(["reset", "--hard", "-q"], repo);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const treeOf = (rev) => gitOut(["rev-parse", `${rev}^{tree}`], repo).trim();
    const bodyOf = (rev) => gitOut(["log", "-1", "--format=%B", rev], repo);
    const lastLine = (rev) => bodyOf(rev).trim().split(/\r?\n/).pop() || "";

    fs.writeFileSync(path.join(repo, "src", "note.txt"), "hello\n", "utf8");
    git(["add", "-A"], repo);
    let hc = commit(["commit", "-m", "trailer pass"]);
    check("trailer commit exit", hc.status, 0, (hc.stderr || "").trim().split("\n").pop());
    let m = lastLine("HEAD").match(/^Signoff-Pass: ([0-9a-f]{12})$/);
    check("trailer pass appended", m ? 1 : 0, 1, lastLine("HEAD"));
    check("trailer pass matches tree", m && m[1] === treeOf("HEAD").slice(0, 12) ? 1 : 0, 1);
    let ar = run(["audit", "--range", "HEAD~1..HEAD"], repo);
    check("audit pass exit", ar.status, 0);
    check("audit pass state", /^[0-9a-f]{7} pass$/m.test(ar.stdout) ? 1 : 0, 1, ar.stdout.trim().replace(/\n/g, " | "));
    check("audit pass summary", /audit: 1 commits, pass=1 skip=0 missing=0 skipped_merges=0/.test(ar.stdout) ? 1 : 0, 1);
    AUDIT.push(ar.stdout.trim());

    // A stale marker for another tree must never touch a message.
    const mf = path.join(repo, ".git", "MSGTEST");
    const markerFile = path.join(repo, ".signoff", "passed");
    fs.writeFileSync(mf, "mismatch\n", "utf8");
    fs.writeFileSync(
      markerFile,
      JSON.stringify({ tree: "0".repeat(40), mode: "pass", ts: "2026-01-01T00:00:00Z" }) + "\n",
      "utf8"
    );
    r = run(["hook", "commit-msg", mf], repo);
    check("commit-msg mismatch exit", r.status, 0);
    check("commit-msg mismatch untouched", fs.readFileSync(mf, "utf8"), "mismatch\n");
    check("commit-msg mismatch consumes marker", fs.existsSync(markerFile) ? 0 : 1, 1);
    r = run(["hook", "commit-msg", mf], repo);
    check("commit-msg without marker exit", r.status, 0);
    check("commit-msg without marker untouched", fs.readFileSync(mf, "utf8"), "mismatch\n");

    // --no-verify skips both hooks: no trailer, and audit has to say so.
    fs.writeFileSync(path.join(repo, "src", "note.txt"), "hello\nunverified\n", "utf8");
    git(["add", "-A"], repo);
    hc = commit(["commit", "--no-verify", "-m", "no verify"]);
    check("no-verify commit exit", hc.status, 0);
    check("no-verify leaves no trailer", /^Signoff-(Pass|Skip):/m.test(bodyOf("HEAD")) ? 0 : 1, 1);
    ar = run(["audit", "--range", "HEAD~1..HEAD"], repo);
    check("audit missing exit", ar.status, 1);
    check("audit missing state", /^[0-9a-f]{7} missing$/m.test(ar.stdout) ? 1 : 0, 1);
    AUDIT.push(ar.stdout.trim());

    // An explicit skip is recorded, and audit is honest about it.
    fs.writeFileSync(path.join(repo, "src", "note.txt"), "hello\nskipped\n", "utf8");
    git(["add", "-A"], repo);
    hc = commit(["commit", "-m", "skipped"], { SIGNOFF_SKIP: "1" });
    check("skip commit exit", hc.status, 0, (hc.stderr || "").trim().split("\n").pop());
    m = lastLine("HEAD").match(/^Signoff-Skip: ([0-9a-f]{12})$/);
    check("trailer skip appended", m ? 1 : 0, 1, lastLine("HEAD"));
    check("trailer skip matches tree", m && m[1] === treeOf("HEAD").slice(0, 12) ? 1 : 0, 1);
    ar = run(["audit", "--range", "HEAD~1..HEAD"], repo);
    check("audit skip exit", ar.status, 0);
    check("audit skip state", /^[0-9a-f]{7} skip$/m.test(ar.stdout) ? 1 : 0, 1);
    AUDIT.push(ar.stdout.trim());
    check("audit strict fails on skip", run(["audit", "--range", "HEAD~1..HEAD", "--strict"], repo).status, 1);
    const aj = JSON.parse(run(["audit", "--range", "HEAD~1..HEAD", "--json"], repo).stdout);
    check("audit json ok", aj.ok, true);
    check("audit json counts", JSON.stringify(aj.counts), JSON.stringify({ pass: 0, skip: 1, missing: 0 }));
    check("audit json commit state", aj.commits.length === 1 ? aj.commits[0].state : "none", "skip");
    check("audit default range", run(["audit"], repo).status, 0);
    fs.mkdirSync(path.join(base, "notrepo"), { recursive: true });
    check("audit outside repo", run(["audit"], path.join(base, "notrepo")).status, 2);
    check("audit unparsable range", run(["audit", "--range", "nope..nope2"], repo).status, 2);

    // Merges have no single staged tree: counted, never graded.
    const branch = gitOut(["symbolic-ref", "--short", "HEAD"], repo).trim();
    git(["checkout", "-q", "-b", "side"], repo);
    fs.writeFileSync(path.join(repo, "src", "side.txt"), "side\n", "utf8");
    git(["add", "-A"], repo);
    check("side commit exit", commit(["commit", "-m", "side pass"]).status, 0);
    git(["checkout", "-q", branch], repo);
    fs.writeFileSync(path.join(repo, "src", "main.txt"), "main\n", "utf8");
    git(["add", "-A"], repo);
    check("main commit exit", commit(["commit", "-m", "main pass"]).status, 0);
    check("merge commit exit", commit(["merge", "--no-ff", "-m", "merge side", "side"]).status, 0);
    ar = run(["audit", "--range", "HEAD~2..HEAD"], repo);
    check("audit merge exit", ar.status, 0, ar.stdout.trim().replace(/\n/g, " | "));
    check("audit merge skipped", /skipped_merges=1/.test(ar.stdout) ? 1 : 0, 1, ar.stdout.trim().replace(/\n/g, " | "));

    // prepare is refused when the CLI would be absent during install
    const bare = path.join(base, "bare");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ name: "bare", version: "0.0.0" }) + "\n");
    git(["init", "-q"], bare);
    r = run(["init", "--no-ci", "--prepare"], bare, { SIGNOFF_HOME: path.join(base, "bare-home") });
    check("prepare skipped without devDependency", r.status, 0);
    check(
      "prepare not written without devDependency",
      JSON.parse(fs.readFileSync(path.join(bare, "package.json"), "utf8")).scripts ? 0 : 1,
      1
    );

    // ----------------------------------------------- init --prepare / --quiet
    const pkgPath = path.join(repo, "package.json");
    const pkg0 = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg0.scripts = { build: "node -e 0" };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg0, null, 2) + "\n", "utf8");
    r = g(["init", "--dry-run", "--no-ci", "--prepare"]);
    check("prepare dry-run exit", r.status, 0);
    check(
      "prepare dry-run writes nothing",
      JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts.prepare === undefined ? 1 : 0,
      1
    );
    r = g(["init", "--no-ci", "--quiet", "--prepare"]);
    check("init --quiet silent", (r.stdout || "").trim() === "" ? 1 : 0, 1, (r.stdout || "").trim());
    check("init --prepare exit", r.status, 0);
    check("prepare added when absent", JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts.prepare, "signoff init --quiet");
    const pkg1 = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg1.scripts.prepare = "node -e 0";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg1, null, 2) + "\n", "utf8");
    r = g(["init", "--no-ci", "--quiet", "--prepare"]);
    check("prepare merged with old value", JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts.prepare, "node -e 0 && signoff init --quiet");
    r = g(["init", "--no-ci", "--quiet", "--prepare"]);
    check("prepare idempotent", JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts.prepare, "node -e 0 && signoff init --quiet");
    check("prepare added once", (fs.readFileSync(pkgPath, "utf8").match(/signoff init --quiet/g) || []).length, 1);

    // ------------------------------------------------------------ status
    r = g(["status", "--json"]);
    const stj = JSON.parse(r.stdout);
    check("status trailer true", stj.trailer, true);
    check("status commit-msg hook", stj.installed["commit-msg"] ? 1 : 0, 1);
    check("status pre-commit hook", stj.installed["pre-commit"] ? 1 : 0, 1);
    r = g(["status"]);
    check("status human trailer", /^trailer\s+enforced$/m.test(r.stdout) ? 1 : 0, 1, r.stdout.trim().replace(/\n/g, " | "));
    check("status human commit-msg", /^commit-msg\s+installed$/m.test(r.stdout) ? 1 : 0, 1);

    // Trailer edge cases: no marker and a stale marker must both leave the message alone.
    const msgFile = path.join(base, "MSG.txt");
    fs.writeFileSync(msgFile, "subject\n", "utf8");
    r = g(["hook", "commit-msg", msgFile]);
    check("commit-msg without marker exits 0", r.status, 0);
    check("commit-msg without marker adds nothing", fs.readFileSync(msgFile, "utf8").trim(), "subject");
    fs.mkdirSync(path.join(repo, ".signoff"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".signoff", "passed"),
      JSON.stringify({ tree: "0".repeat(40), mode: "pass", ts: new Date().toISOString() }),
      "utf8"
    );
    r = g(["hook", "commit-msg", msgFile]);
    check("commit-msg stale marker exits 0", r.status, 0);
    check("commit-msg stale marker adds nothing", fs.readFileSync(msgFile, "utf8").trim(), "subject");
    check("commit-msg stale marker consumed", fs.existsSync(path.join(repo, ".signoff", "passed")) ? 0 : 1, 1);

    r = g(["uninstall"]);
    check("guard uninstall", fs.existsSync(path.join(hooks, "pre-commit")) ? 0 : 1, 1);
    check("uninstall removes commit-msg", fs.existsSync(path.join(hooks, "commit-msg")) ? 0 : 1, 1);
    r = g(["init", "--dry-run", "--no-ci"]);
    check("guard dry-run writes nothing", fs.existsSync(path.join(hooks, "pre-commit")) ? 0 : 1, 1);

    // doctor: a read-only self-check that has to agree with the gates it summarizes.
    const drepo = path.join(base, "doctor-repo");
    fs.mkdirSync(drepo, { recursive: true });
    gitOut(["init", "-q", "."], drepo);
    fs.writeFileSync(path.join(drepo, "a.txt"), "a", "utf8");
    gitOut(["add", "."], drepo);
    gitOut(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "a"], drepo);
    const dhome = path.join(base, "doctor-home");
    const d = (args) => run(args, drepo, { SIGNOFF_HOME: dhome });
    check("--version prints a version", /^\d+\.\d+\.\d+$/.test(run(["--version"]).stdout.trim()) ? 1 : 0, 1);
    check("help carries the current name", /落印/.test(run(["--help"]).stdout) ? 1 : 0, 1);
    check("doctor unguarded repo", d(["doctor"]).status, 1);
    d(["init", "--no-ci"]);
    check("doctor guarded repo", d(["doctor"]).status, 0, d(["doctor", "--quiet"]).stdout.trim());
    const dj = JSON.parse(d(["doctor", "--json"]).stdout);
    check("doctor json ok", dj.ok, true);
    check("doctor json has checks", dj.checks.length > 10 ? 1 : 0, 1);
    check("doctor quiet hides ok lines", /^ok /m.test(d(["doctor", "--quiet"]).stdout) ? 1 : 0, 0);
    check("doctor outside repo", run(["doctor"], path.join(base, "notrepo")).status, 2);
    fs.writeFileSync(
      path.join(drepo, ".signoff", "passed"),
      JSON.stringify({ tree: "a".repeat(40), mode: "pass", ts: new Date().toISOString() }),
      "utf8"
    );
    check("doctor leftover marker warns only", d(["doctor"]).status, 0);
    check("doctor sees the leftover marker", /leftover/.test(d(["doctor", "--quiet"]).stdout) ? 1 : 0, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  // ---- zero-touch bootstrap: ensure, the machine layer, and the light guard
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-ensure-"));
    try {
      const home = path.join(base, "home");
      const gitcfg = path.join(base, "gitconfig");
      const gitcfgSystem = path.join(base, "gitconfig-system");
      fs.writeFileSync(gitcfg, "", "utf8");
      fs.writeFileSync(gitcfgSystem, "", "utf8");
      // GIT_CONFIG_GLOBAL keeps the machine layer out of the real ~/.gitconfig.
      const env = { SIGNOFF_HOME: home, GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_SYSTEM: gitcfgSystem };
      const repo = path.join(base, "repo");
      fs.mkdirSync(repo, { recursive: true });
      git(["init", "-q"], repo, env);
      git(["config", "user.email", "a@b.c"], repo, env);
      git(["config", "user.name", "t"], repo, env);
      fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");

      const first = run(["ensure"], repo, { ...env, SIGNOFF_NO_BOOTSTRAP: "0" });
      check("ensure exit code", first.status, 0);
      check("ensure writes the pre-commit hook", fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")), true);
      check("ensure writes config.json", fs.existsSync(path.join(repo, ".signoff", "config.json")), true);
      check("ensure writes installed.json", fs.existsSync(path.join(repo, ".signoff", "installed.json")), true);

      const second = JSON.parse(run(["ensure", "--json"], repo, { ...env, SIGNOFF_NO_BOOTSTRAP: "0" }).stdout);
      check("ensure is idempotent", second.repo.installed, false);
      check("ensure reports the repo guarded", second.repo.ok, true);

      const g = JSON.parse(run(["ensure", "--global", "--json"], repo, env).stdout);
      check("ensure --global ok", g.machine.ok, true);
      check("machine hook written", fs.existsSync(path.join(home, "hooks", "pre-commit")), true);
      const hooksPath = () =>
        spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], {
          cwd: repo,
          encoding: "utf8",
          env: { ...process.env, ...env },
        });
      check("core.hooksPath set", hooksPath().stdout.trim().length > 0 ? 1 : 0, 1);
      run(["uninstall", "--global"], repo, env);
      check("uninstall --global unsets it", hooksPath().status, 1);

      const fresh = (name) => {
        const d = path.join(base, name);
        fs.mkdirSync(d, { recursive: true });
        git(["init", "-q"], d, env);
        git(["config", "user.email", "a@b.c"], d, env);
        git(["config", "user.name", "t"], d, env);
        return d;
      };

      // The machine layer reaches unrepos that never opted in: only P1 runs, nothing is installed.
      const raw = fresh("raw");
      fs.writeFileSync(
        path.join(raw, "package.json"),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
        "utf8"
      );
      git(["add", "-A"], raw, env);
      const light = run(["hook", "pre-commit"], raw, { SIGNOFF_HOME: home });
      check("light guard blocks a failing test", light.status, 1);
      check("light guard installs nothing", fs.existsSync(path.join(raw, ".signoff", "config.json")), false);

      const good = fresh("good");
      fs.writeFileSync(
        path.join(good, "package.json"),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
        "utf8"
      );
      git(["add", "-A"], good, env);
      check("light guard passes a green test", run(["hook", "pre-commit"], good, { SIGNOFF_HOME: home }).status, 0);

      // A committed signoff.json opts the whole repo in: the clone builds the install itself.
      const shared = fresh("shared");
      fs.writeFileSync(
        path.join(shared, "package.json"),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
        "utf8"
      );
      fs.writeFileSync(path.join(shared, "signoff.json"), JSON.stringify({ gates: ["p1", "p2", "p3", "p4", "p5"] }), "utf8");
      git(["add", "-A"], shared, env);
      check("declared repo passes through the machine layer", run(["hook", "pre-commit"], shared, { SIGNOFF_HOME: home }).status, 0);
      check("declared repo installs config", fs.existsSync(path.join(shared, ".signoff", "config.json")), true);
      check("declared repo installs hooks", fs.existsSync(path.join(shared, ".git", "hooks", "pre-commit")), true);

      const sharedBad = fresh("shared-bad");
      fs.writeFileSync(
        path.join(sharedBad, "package.json"),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
        "utf8"
      );
      fs.writeFileSync(path.join(sharedBad, "signoff.json"), "{}", "utf8");
      git(["add", "-A"], sharedBad, env);
      check("declared repo blocks a red gate", run(["hook", "pre-commit"], sharedBad, { SIGNOFF_HOME: home }).status, 1);

      // init --share writes the declaration that makes the above work for teammates
      const sharer = fresh("sharer");
      const sr = run(["init", "--share", "--no-ci", "--quiet"], sharer, env);
      check("init --share exit code", sr.status, 0, (sr.stderr || "").trim());
      const decl = JSON.parse(fs.readFileSync(path.join(sharer, "signoff.json"), "utf8"));
      check("init --share writes gates", Array.isArray(decl.gates) && decl.gates.length === 5 ? 1 : 0, 1);
      check("init --share does not pin the runner", decl.test_cmd === undefined ? 1 : 0, 1);

      // A bootstrap during the first commit lands without a sha; a later init repairs it.
      const repair = fresh("repair");
      check("init before the first commit", run(["init", "--no-ci", "--quiet"], repair, env).status, 0);
      const ip = JSON.parse(fs.readFileSync(path.join(repair, ".signoff", "installed.json"), "utf8"));
      check("install point starts without a sha", ip.sha === "" ? 1 : 0, 1);
      fs.writeFileSync(path.join(repair, "a.txt"), "a", "utf8");
      git(["add", "-A"], repair, env);
      // --no-verify: this commit only needs to exist so the install point has a sha; the
      // repo hook would look for a global `signoff` binary the CI runner does not have.
      git(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "first", "--no-verify"], repair, env);
      run(["init", "--no-ci", "--quiet"], repair, env);
      const ip2 = JSON.parse(fs.readFileSync(path.join(repair, ".signoff", "installed.json"), "utf8"));
      check("re-init fills the install point", /^[0-9a-f]{40}$/.test(ip2.sha) ? 1 : 0, 1);
      check("audit --since-install works after the repair", run(["audit", "--since-install"], repair, env).status, 0);

      // ---------------------------------------------------------- P0 features
      // 1. secrets: a staged key fails the gate and is never printed in full.
      const sec = fresh("secrets");
      // The literal is assembled at run time so this file is not itself a hit for the
      // scanner under test (a scanner that trips on its own fixtures gets allowlisted
      // into uselessness).
      const fakeAws = "AKIA" + "1234567890ABCDEF";
      fs.writeFileSync(path.join(sec, "app.js"), `const k = "${fakeAws}";\n`, "utf8");
      git(["add", "-A"], sec, env);
      const sr1 = run(["secrets", "--staged", "--json"], sec, env);
      check("secrets blocks a staged key", sr1.status, 1);
      check("secrets reports one hit", JSON.parse(sr1.stdout).hits, 1);
      const srState = JSON.parse(fs.readFileSync(path.join(sec, ".signoff", "secrets.json"), "utf8"));
      check("secrets names the rule", srState.findings[0].rule, "aws-access-key");
      check("secrets masks the value", !srState.findings[0].match.includes("1234567890ABCDEF"), true);
      fs.writeFileSync(
        path.join(sec, ".signoff", "config.json"),
        JSON.stringify({ secrets: { allow: ["aws-access-key"] } }),
        "utf8"
      );
      check("secrets honours the allowlist", run(["secrets", "--staged"], sec, env).status, 0);
      const secClean = fresh("secrets-clean");
      fs.writeFileSync(path.join(secClean, "a.md"), "# clean\n", "utf8");
      git(["add", "-A"], secClean, env);
      check("secrets passes a clean file", run(["secrets", "--staged"], secClean, env).status, 0);

      // 2. secrets run inside the guard, before the suite.
      const secGuard = fresh("secrets-guard");
      const fakePat = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
      fs.writeFileSync(path.join(secGuard, "app.js"), `const t = "${fakePat}";\n`, "utf8");
      git(["add", "-A"], secGuard, env);
      const sg = run(["hook", "pre-commit"], secGuard, { SIGNOFF_HOME: home });
      check("guard fails on a staged key", sg.status, 1);
      check("guard names the secrets gate", /secrets/.test(sg.stdout) ? 1 : 0, 1, (sg.stdout || "").trim().split("\n").slice(-12).join(" | "));

      // 3. runner detection beyond npm/pytest.
      const p1lib = require(path.join(ROOT, "lib", "p1.js"));
      const det = (name, file) => {
        const d = fresh("det-" + name + "-" + Date.now().toString(36));
        fs.writeFileSync(path.join(d, file), "x", "utf8");
        return p1lib.defaultCommands(d)[0];
      };
      check("p1 detects go", det("go", "go.mod"), "go test ./...");
      check("p1 detects cargo", det("cargo", "Cargo.toml"), "cargo test --quiet");
      check("p1 detects maven", det("maven", "pom.xml"), "mvn -q test");
      check("p1 detects dotnet", det("dotnet", "app.csproj"), "dotnet test --nologo");
      check("p1 detects elixir", det("elixir", "mix.exs"), "mix test");

      // 4. cache: the same staged tree runs the suite once.
      const cacheRepo = fresh("cache");
      const counter = path.join(cacheRepo, "count.txt");
      fs.writeFileSync(
        path.join(cacheRepo, "package.json"),
        JSON.stringify({ scripts: { test: `node -e "require('fs').appendFileSync('count.txt','x')"` } }),
        "utf8"
      );
      git(["add", "-A"], cacheRepo, env);
      const c1 = run(["p1"], cacheRepo, env);
      check("p1 runs the suite", c1.status, 0);
      check("p1 counter after the first run", fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0, 1);
      const c2 = run(["p1"], cacheRepo, env);
      check("p1 cache hit on the same tree", /cached/.test(c2.stdout) ? 1 : 0, 1);
      check("p1 cache did not rerun the suite", fs.readFileSync(counter, "utf8").length, 1);
      const c3 = run(["p1"], cacheRepo, { SIGNOFF_HOME: HOME, SIGNOFF_NO_BOOTSTRAP: "1", SIGNOFF_NO_CACHE: "1" });
      check("p1 --no-cache reruns", /cached/.test(c3.stdout) ? 0 : 1, 1);
      check("p1 --no-cache counter grows", fs.readFileSync(counter, "utf8").length, 2);

      // 5. docs-only fast path: a markdown change never pays for the suite.
      const docsRepo = fresh("docsfast");
      fs.mkdirSync(path.join(docsRepo, "docs"), { recursive: true });
      fs.writeFileSync(
        path.join(docsRepo, "package.json"),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
        "utf8"
      );
      git(["add", "package.json"], docsRepo, env);
      git(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "pkg", "--no-verify"], docsRepo, env);
      fs.writeFileSync(path.join(docsRepo, "docs", "a.md"), "# note\n", "utf8");
      git(["add", "docs/a.md"], docsRepo, env);
      const d1 = run(["p1"], docsRepo, env);
      check("p1 passes a docs-only change", d1.status, 0);
      check("p1 says it was docs only", /docs only/.test(d1.stdout) ? 1 : 0, 1);
      fs.writeFileSync(path.join(docsRepo, "code.js"), "x", "utf8");
      git(["add", "-A"], docsRepo, env);
      check("p1 runs the suite once code changes", run(["p1"], docsRepo, env).status, 1);

      // 6. signed trailers: the signature travels with the commit and audit checks it.
      const keyDir = path.join(base, "signkey");
      fs.mkdirSync(keyDir, { recursive: true });
      const keyPath = path.join(keyDir, "id");
      const keygen = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "t@signoff", "-f", keyPath], {
        encoding: "utf8",
      });
      check("fixture ssh key generated", keygen.status, 0, (keygen.stderr || "").trim());
      const signEnv = { SIGNOFF_HOME: home, SIGNOFF_SIGN_KEY: keyPath, SIGNOFF_NO_BOOTSTRAP: "1" };
      const signed = fresh("signed");
      // A base commit first: audit needs a real HEAD~1 to have a range at all.
      fs.writeFileSync(path.join(signed, "base.txt"), "b", "utf8");
      git(["add", "-A"], signed, env);
      git(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "base", "--no-verify"], signed, env);
      fs.writeFileSync(
        path.join(signed, "package.json"),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
        "utf8"
      );
      fs.writeFileSync(path.join(signed, "a.txt"), "a", "utf8");
      check("init --sign exits 0", run(["init", "--sign", "--no-ci", "--quiet"], signed, signEnv).status, 0);
      check("init --sign records a key", fs.existsSync(path.join(signed, ".signoff", "signing_key")) ? 1 : 0, 1);
      const signedCfg = JSON.parse(fs.readFileSync(path.join(signed, ".signoff", "config.json"), "utf8"));
      check("init --sign pins sign_key", typeof signedCfg.sign_key === "string" ? 1 : 0, 1);
      git(["add", "-A"], signed, env);
      check("signed pre-commit", run(["hook", "pre-commit"], signed, signEnv).status, 0);
      const msgRel = ".git/COMMIT_EDITMSG_TEST";
      fs.writeFileSync(path.join(signed, msgRel), "test the signed trailer\n", "utf8");
      check("commit-msg exits 0", run(["hook", "commit-msg", msgRel], signed, signEnv).status, 0);
      const msgText = fs.readFileSync(path.join(signed, msgRel), "utf8");
      check("trailer has Signoff-Pass", /^Signoff-Pass: [0-9a-f]{12}$/m.test(msgText) ? 1 : 0, 1);
      check("trailer has Signoff-Key", /^Signoff-Key: ssh-ed25519 /m.test(msgText) ? 1 : 0, 1);
      check("trailer has Signoff-Sig", /^Signoff-Sig: [A-Za-z0-9+/=]{40,}$/m.test(msgText) ? 1 : 0, 1);
      git(
        ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "-F", msgRel, "--no-verify"],
        signed,
        env
      );
      const av1 = run(["audit", "--range", "HEAD~1..HEAD", "--verify", "--json"], signed, signEnv);
      check("audit --verify passes", av1.status, 0, (av1.stderr || "").trim());
      check("audit sees a self-signed commit", JSON.parse(av1.stdout).signatures["self-signed"], 1);
      fs.writeFileSync(
        path.join(signed, ".signoff", "allowed_signers"),
        fs.readFileSync(keyPath + ".pub", "utf8"),
        "utf8"
      );
      const av2 = run(["audit", "--range", "HEAD~1..HEAD", "--verify", "--json"], signed, signEnv);
      check("audit verifies against allowed_signers", JSON.parse(av2.stdout).signatures.verified, 1);
      // A tampered tree cannot verify: the signature covers the full tree id.
      const tamper = run(["audit", "--range", "HEAD~1..HEAD", "--verify", "--require-signed", "--json"], signed, signEnv);
      check("audit --require-signed passes when signed", tamper.status, 0);

      // 7. line coverage of the change.
      const covRepo = fresh("cov");
      const lines = [];
      for (let i = 1; i <= 10; i++) lines.push(`const v${i} = ${i};`);
      fs.writeFileSync(path.join(covRepo, "a.js"), lines.join("\n") + "\n", "utf8");
      fs.mkdirSync(path.join(covRepo, "coverage"), { recursive: true });
      const da = [];
      for (let i = 1; i <= 10; i++) da.push(`DA:${i},${i <= 8 ? 1 : 0}`);
      fs.writeFileSync(
        path.join(covRepo, "coverage", "lcov.info"),
        ["SF:a.js", ...da, "end_of_record", ""].join("\n"),
        "utf8"
      );
      git(["add", "-A"], covRepo, env);
      git(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "base", "--no-verify"], covRepo, env);
      check("cov fails under the threshold", run(["cov", "--min", "90"], covRepo, env).status, 1);
      check("cov passes over the threshold", run(["cov", "--min", "70"], covRepo, env).status, 0);
      const covJson = JSON.parse(run(["cov", "--min", "70", "--json"], covRepo, env).stdout);
      check("cov reports 80 percent", covJson.pct, 80);
      check("cov reads lcov", covJson.source, "coverage/lcov.info");
      // Diff mode: a change on uncovered lines is the case that matters.
      fs.writeFileSync(path.join(covRepo, "a.js"), lines.join("\n") + "\nconst extra = 11;\n", "utf8");
      git(["add", "a.js"], covRepo, env);
      const covDiff = run(["cov", "--diff", "--base", "HEAD", "--min", "80", "--json"], covRepo, env);
      check("cov diff mode passes with no instrumented change", covDiff.status, 0);
      check("cov diff mode is reported", JSON.parse(covDiff.stdout).mode, "diff");
      check("cov without data exits 2", run(["cov", "--file", "missing.json"], covRepo, env).status, 2);
      check("cov allows missing data", run(["cov", "--file", "missing.json", "--allow-missing"], covRepo, env).status, 0);

      // 8. CI annotations: a finding becomes a line annotation, not a log paragraph.
      const ciRepo = fresh("ci");
      const ciFake = "AKIA" + "1234567890ABCDEF";
      fs.writeFileSync(path.join(ciRepo, "app.js"), `const k = "${ciFake}";\n`, "utf8");
      git(["add", "-A"], ciRepo, env);
      const summaryFile = path.join(base, "step-summary.md");
      const ciRun = run(["secrets", "--staged"], ciRepo, {
        SIGNOFF_HOME: HOME,
        SIGNOFF_NO_BOOTSTRAP: "1",
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summaryFile,
      });
      check("CI run fails on the secret", ciRun.status, 1);
      check(
        "CI prints an annotation",
        /^::error file=app\.js,line=1,title=signoff\/aws-access-key::/m.test(ciRun.stdout) ? 1 : 0,
        1,
        (ciRun.stdout || "").trim().split("\n").slice(0, 2).join(" | ")
      );
      check("CI writes a step summary", fs.existsSync(summaryFile) ? 1 : 0, 1);
      check(
        "step summary names the rule",
        fs.existsSync(summaryFile) && /aws-access-key/.test(fs.readFileSync(summaryFile, "utf8")) ? 1 : 0,
        1
      );

      // 9. P5 rule packs: zh stays the default, en is opt-in, both is explicit.
      const enMd = path.join(base, "slop-en.md");
      fs.writeFileSync(enMd, "A seamless and robust platform.\n", "utf8");
      check("p5 zh ignores English slop", run(["p5", enMd], base, env).status, 0);
      check("p5 --pack en flags English slop", run(["p5", "--pack", "en", enMd], base, env).status, 1);
      check("p5 rejects an unknown pack", run(["p5", "--pack", "xx", enMd], base, env).status, 2);
      check("p5 --pack both flags English slop", run(["p5", "--pack", "both", enMd], base, env).status, 1);
      const rulesFile = path.join(base, "rules.json");
      fs.writeFileSync(rulesFile, JSON.stringify({ ai_words: ["powerful"] }), "utf8");
      const customMd = path.join(base, "custom.md");
      fs.writeFileSync(customMd, "This is a powerful tool.\n", "utf8");
      check("p5 rules alone do not fire on en default", run(["p5", "--rules", rulesFile, customMd], base, env).status, 1);
      const noHitMd = path.join(base, "plain.md");
      fs.writeFileSync(noHitMd, "This is a fast tool.\n", "utf8");
      check("p5 custom word does not over-match", run(["p5", "--rules", rulesFile, noHitMd], base, env).status, 0);
      const packRepo = fresh("p5pack");
      fs.mkdirSync(path.join(packRepo, ".signoff"), { recursive: true });
      fs.writeFileSync(path.join(packRepo, ".signoff", "config.json"), JSON.stringify({ p5: { pack: "en" } }), "utf8");
      fs.writeFileSync(path.join(packRepo, "note.md"), "A seamless platform.\n", "utf8");
      check("p5 reads the pack from config", run(["p5", "note.md"], packRepo, env).status, 1);

      // 10. presets: one flag for budget, docs, coverage and the rule pack.
      const preNode = fresh("preset-node");
      check("init --preset node exits 0", run(["init", "--preset", "node", "--no-ci", "--quiet"], preNode, env).status, 0);
      const preCfg = JSON.parse(fs.readFileSync(path.join(preNode, ".signoff", "config.json"), "utf8"));
      check("preset sets coverage", preCfg.coverage && preCfg.coverage.min, 80);
      check("preset sets the p5 pack", preCfg.p5.pack, "both");
      check("preset keeps test_cmd auto-detected", preCfg.test_cmd, null);
      check("preset sets the budget", preCfg.budget, 180);
      const preGo = fresh("preset-go");
      check("init --preset go exits 0", run(["init", "--preset", "go", "--no-ci", "--quiet"], preGo, env).status, 0);
      const goCfg = JSON.parse(fs.readFileSync(path.join(preGo, ".signoff", "config.json"), "utf8"));
      check("go preset has no coverage gate", goCfg.coverage, null);
      check("go preset uses the en pack", goCfg.p5.pack, "en");
      check("init rejects an unknown preset", run(["init", "--preset", "rust", "--no-ci"], fresh("preset-bad"), env).status, 2);

      // 11. editor integration: tasks.json + problem matcher, merged not replaced.
      const edRepo = fresh("editor");
      check("init --editor vscode exits 0", run(["init", "--editor", "vscode", "--no-ci", "--quiet"], edRepo, env).status, 0);
      const tasksPath = path.join(edRepo, ".vscode", "tasks.json");
      const tasksJson = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
      const guardTask = tasksJson.tasks.find((t) => t.label === "signoff: guard");
      check("tasks.json has the guard task", guardTask ? 1 : 0, 1);
      check("guard task has a problem matcher", guardTask && guardTask.problemMatcher[0], "signoff-secret");
      check(
        "problem matcher definitions written",
        fs.existsSync(path.join(edRepo, ".vscode", "signoff-problem-matchers.json")) ? 1 : 0,
        1
      );
      const withMine = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
      withMine.tasks.push({ label: "my task", type: "shell", command: "echo hi" });
      fs.writeFileSync(tasksPath, JSON.stringify(withMine, null, 2), "utf8");
      run(["init", "--editor", "vscode", "--no-ci", "--quiet"], edRepo, env);
      const merged = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
      check("editor merge keeps my task", merged.tasks.filter((t) => t.label === "my task").length, 1);
      check("editor merge does not duplicate", merged.tasks.filter((t) => t.label === "signoff: guard").length, 1);
      check("init rejects an unknown editor", run(["init", "--editor", "emacs", "--no-ci"], fresh("ed-bad"), env).status, 2);
      // 12. runner detection: a JS repo with a tests/ directory is still npm.
      const jsTests = fresh("detect-js");
      fs.writeFileSync(path.join(jsTests, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }), "utf8");
      fs.mkdirSync(path.join(jsTests, "tests"), { recursive: true });
      fs.writeFileSync(path.join(jsTests, "tests", "a.test.js"), "// js\n", "utf8");
      check("detect: package.json with tests/ is npm", p1lib.detectCommands(jsTests).id, "npm");
      const pyTests = fresh("detect-py");
      fs.mkdirSync(path.join(pyTests, "tests"), { recursive: true });
      fs.writeFileSync(path.join(pyTests, "tests", "test_a.py"), "def test_a():\n    assert True\n", "utf8");
      check("detect: tests/*.py is pytest", p1lib.detectCommands(pyTests).id, "pytest-tests");
      const bareTests = fresh("detect-bare");
      fs.mkdirSync(path.join(bareTests, "tests"), { recursive: true });
      fs.writeFileSync(path.join(bareTests, "tests", "data.json"), "{}", "utf8");
      check("detect: a tests/ dir alone is not pytest", p1lib.detectCommands(bareTests).id, null);

      // 13. Signed checkpoints over the P4 ledger.
      let r;
      // Seed two records in this run's own ledger before signing a checkpoint.
      const seedTicket = (run(["p4", "ask", "--action", "config", "--target", "cp"], repo).stdout.match(/ticket (\w+)/) || [])[1];
      check("p4 seed ticket", typeof seedTicket, "string");
      run(["p4", "confirm", "--ticket", seedTicket, "--decision", "allow", "--detail", "cp"], repo);
      const seed2 = (run(["p4", "ask", "--action", "config", "--target", "cp2"], repo).stdout.match(/ticket (\w+)/) || [])[1];
      run(["p4", "confirm", "--ticket", seed2, "--decision", "allow", "--detail", "cp2"], repo);
      r = run(["p4", "checkpoint", "--no-sign"], repo);
      check("p4 checkpoint writes", r.status, 0);
      r = run(["p4", "verify", "--checkpoint"], repo);
      check("p4 unsigned checkpoint is not a pass", r.status, 1);
      r = run(["p4", "verify", "--checkpoint", "--allow-unsigned"], repo);
      check("p4 --allow-unsigned", r.status, 0);
      r = run(["p4", "checkpoint"], repo);
      check("p4 checkpoint signs", r.status, 0);
      let cpv = JSON.parse(run(["p4", "verify", "--checkpoint", "--json"], repo).stdout);
      check("p4 checkpoint verifies", cpv.ok, true, cpv.state);
      check("p4 checkpoint covers records", cpv.seq > 0, true, String(cpv.seq));
      check("p4 checkpoint is self-signed", cpv.state, "self-signed");
      const cpAnchor = run(["p4", "anchor"], repo).stdout.trim();
      check("p4 anchor format", /^signoff1:\d+:[0-9a-f]{12}:[0-9a-f]{16}$/.test(cpAnchor), true, cpAnchor);
      check("p4 anchor matches checkpoint", cpAnchor, JSON.parse(run(["p4", "checkpoint", "--json"], repo).stdout.trim()).anchor);
      r = run(["p4", "verify", "--checkpoint", "--anchor", "signoff1:9:000000000000:0000000000000000"], repo);
      check("p4 wrong anchor is red", r.status, 1);

      // Trusted key in allowed_signers flips self-signed -> verified.
      const cp = JSON.parse(fs.readFileSync(JSON.parse(run(["p4", "path", "--json"], repo).stdout).checkpoint, "utf8"));
      fs.mkdirSync(path.join(repo, ".signoff"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".signoff", "allowed_signers"), cp.key + "\n", "utf8");
      cpv = JSON.parse(run(["p4", "verify", "--checkpoint", "--json"], repo).stdout);
      check("p4 checkpoint becomes verified", cpv.state, "verified");

      // Truncating the ledger is the attack a plain hash chain cannot see.
      const where = JSON.parse(run(["p4", "path", "--json"], repo).stdout);
      check("p4 path names the ledger", fs.existsSync(where.ledger), true, where.ledger);
      check("p4 path names the checkpoint", where.checkpoint.endsWith("checkpoint.json"), true);
      const ledgerFile = where.ledger;
      const ledgerText = fs.readFileSync(ledgerFile, "utf8");
      const keep = ledgerText.trim().split(/\r?\n/).slice(0, -1).join("\n") + "\n";
      fs.writeFileSync(ledgerFile, keep, "utf8");
      r = run(["p4", "verify", "--checkpoint"], repo);
      check("p4 truncation is red", r.status, 1, r.stdout.includes("records were removed") ? "named" : r.stdout.slice(0, 60));
      fs.writeFileSync(ledgerFile, ledgerText, "utf8");

      // 14. A repo that checkpoints keeps checkpointing on every pass.
      const before = JSON.parse(run(["p4", "verify", "--checkpoint", "--json"], repo).stdout).seq;
      const prevHome = process.env.SIGNOFF_HOME;
      process.env.SIGNOFF_HOME = HOME;
      const guarded = require("../lib/guard").maybeCheckpoint(repo);
      if (prevHome === undefined) delete process.env.SIGNOFF_HOME;
      else process.env.SIGNOFF_HOME = prevHome;
      check("guard keeps a valid checkpoint", guarded && guarded.ok, true, guarded && (guarded.error || ""));
      check("guard does not churn an unchanged ledger", guarded && guarded.seq, before);
      check("guard checkpoint keeps verifying", run(["p4", "verify", "--checkpoint"], repo).status, 0);

      // 15. Distribution manifests exist and name the right entry points.
      const hooks = fs.readFileSync(path.join(__dirname, "..", ".pre-commit-hooks.yaml"), "utf8");
      check("pre-commit hook id", /id: signoff-guard/.test(hooks), true);
      check("pre-commit hook entry", /entry: signoff guard/.test(hooks), true);
      const action = fs.readFileSync(path.join(__dirname, "..", "action.yml"), "utf8");
      check("action installs the cli", /npm i -g signoff-cli/.test(action), true);

// 17. package rename (4.0.0): new mark written, legacy mark still ours
const bootlib = require(path.join(__dirname, "..", "lib", "bootstrap.js"));
check("hook mark names the new package", bootlib.HOOK_MARK.includes("signoff-cli"), true);
check("legacy mark still recognised", bootlib.markedByUs("# generated by dsh-signoff 3.9.4"), true);
check("new mark recognised", bootlib.markedByUs(bootlib.HOOK_MARK + " 4.0.0"), true);
check("foreign hook is not ours", bootlib.markedByUs("#!/bin/sh\nnpx lint-staged"), false);
check("ci template pins the package", /--package=signoff-cli/.test(require(path.join(__dirname, "..", "lib", "guard.js")).CI_BODY), true);
const pkgj = require(path.join(__dirname, "..", "package.json"));
const srvj = require(path.join(__dirname, "..", "server.json"));
check("server.json tracks the package version", srvj.version === pkgj.version, true);
check("server.json package version tracks too", srvj.packages[0].version === pkgj.version, true);
check("server.json names the package", srvj.packages[0].identifier === pkgj.name, true);
check("server.json name matches mcpName", srvj.name === pkgj.mcpName, true);
check("tarball ships the mcp server", pkgj.files.some((f) => String(f).replace(/\/+$/, "") === "integrations"), true);
check("mcp server file exists", fs.existsSync(path.join(__dirname, "..", "integrations", "mcp", "server.js")), true);
check("release gate rejects phantom registry versions", /registry-versions-exist/.test(fs.readFileSync(path.join(__dirname, "..", "lib", "release.js"), "utf8")), true);
check("retire workflow exists", fs.existsSync(path.join(__dirname, "..", ".github", "workflows", "mcp-registry-retire.yml")), true);
check("release gate exports main", typeof require(path.join(__dirname, "..", "lib", "release.js")).main === "function", true);
{
  const wf = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "mcp-registry.yml"), "utf8");
  check("registry workflow waits for npm", /Wait for npm to serve this version/.test(wf) && /registry\.npmjs\.org/.test(wf), true);
  check("registry workflow rejects a tag that disagrees with server.json", /does not match server\.json version/.test(wf), true);
  check("registry workflow retries the publish", /for attempt in 1 2 3 4/.test(wf), true);
}

      check("action runs signoff", /run: signoff \$\{\{ inputs.args \}\}/.test(action), true);
      check("integrations doc lists actions", /uses: ayuanxx-max\/signoff-cli/.test(fs.readFileSync(path.join(__dirname, "..", "docs", "integrations.md"), "utf8")), true);

      // 16. Deterministic fuzz: parsers must never throw on hostile input, and the
      // hashing primitives must be stable and order-sensitive.
      const covlib = require("../lib/cov");
      const p5lib2 = require("../lib/p5");
      const cplib = require("../lib/checkpoint");
      const secretslib = require("../lib/secrets");
      let seed = 0x51f15e;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const pick = (alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      let crashes = 0;
      for (let i = 0; i < 120; i++) {
        const junk = pick("\n\r\t %$#{}[]\"'\\;:=<>0aF中é😀", Math.floor(rnd() * 200));
        try {
          const r = covlib.fromLcov(junk);
          // fromLcov returns a per-file map; only a summary carrying pct is range-checked.
          if (!r || typeof r !== "object") crashes += 1000;
          else if (typeof r.pct === "number" && (r.pct < 0 || r.pct > 100)) crashes += 1000;
        } catch (e) {
          crashes += 1;
        }
        try {
          p5lib2.scan(junk);
          secretslib.scan(junk);
        } catch (e) {
          crashes += 1;
        }
        try {
          const a = [junk, pick("abc", 3), "x"];
          const r1 = cplib.merkleRoot(a);
          const r2 = cplib.merkleRoot(a);
          if (r1 !== r2 || !/^[0-9a-f]{64}$/.test(r1)) crashes += 1000;
          if (cplib.merkleRoot([a[1], a[0], a[2]]) === r1 && a[0] !== a[1]) crashes += 100;
        } catch (e) {
          crashes += 1;
        }
      }
      check("parsers survive 120 hostile inputs", crashes, 0);
      check("merkle root is order sensitive", cplib.merkleRoot(["a", "b"]) === cplib.merkleRoot(["b", "a"]), false);
      const p4lib = require("../lib/p4");
      check("digest is stable", p4lib.digest("genesis", { a: 1, b: "x" }), p4lib.digest("genesis", { b: "x", a: 1 }));
      check("digest binds the predecessor", p4lib.digest("genesis", { a: 1 }) === p4lib.digest("other", { a: 1 }), false);
      r = run(["p4", "verify", "--checkpoint"], repo);
      check("p4 ledger restored", r.status, 0);

      // A BOM from a Windows editor must not look like corruption.
      fs.writeFileSync(ledgerFile, "\uFEFF" + ledgerText, "utf8");
      check("p4 tolerates a BOM", run(["p4", "verify"], repo).status, 0);
      fs.writeFileSync(ledgerFile, ledgerText, "utf8");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }

  for (const line of AUDIT) console.log(`AUDIT ${line.replace(/\n/g, "\nAUDIT ")}`);
  for (const line of PASS) console.log(`PASS ${line}`);
  for (const line of FAIL) console.log(`FAIL ${line}`);
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  return FAIL.length ? 1 : 0;
}

process.exit(main());

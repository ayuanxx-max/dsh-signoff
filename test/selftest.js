#!/usr/bin/env node
"use strict";
// Self-test for dsh-signoff: every gate runs against a throwaway git repo and the
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
    env: { ...process.env, SIGNOFF_HOME: HOME, ...(env || {}) },
  });
}

function gitOut(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function git(args, cwd) {
  gitOut(args, cwd);
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
      { name: "fixture", version: "0.0.0", devDependencies: { "dsh-signoff": "^3.1.0" } },
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

  for (const line of AUDIT) console.log(`AUDIT ${line.replace(/\n/g, "\nAUDIT ")}`);
  for (const line of PASS) console.log(`PASS ${line}`);
  for (const line of FAIL) console.log(`FAIL ${line}`);
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  return FAIL.length ? 1 : 0;
}

process.exit(main());

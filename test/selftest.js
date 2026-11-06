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

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function buildRepo(base) {
  const repo = path.join(base, "repo");
  for (const d of ["tests", "verify/scenarios", "docs", "tasks/t1", "tasks/t2"]) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
  }
  const w = (p, s) => fs.writeFileSync(path.join(repo, p), s, "utf8");
  w("package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }, null, 2) + "\n");
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

    // P5
    r = run(["p5", "docs/dirty.md"], repo);
    check("p5 dirty red", r.status, 1);
    r = run(["p5", "docs/clean.md"], repo);
    check("p5 clean green", r.status, 0);

    // Guard: install once, then the gates run themselves.
    const ghome = path.join(base, "guard-home");
    const g = (args, env) => run(args, repo, { SIGNOFF_HOME: ghome, ...(env || {}) });
    r = g(["init", "--no-ci"]);
    check("guard init", r.status, 0);
    const hooks = path.join(repo, ".git", "hooks");
    check("guard pre-commit hook", fs.existsSync(path.join(hooks, "pre-commit")) ? 1 : 0, 1);
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
    r = g(["hook", "pre-commit"]);
    check("guard hook pass", r.status, 0);
    r = g(["hook", "pre-commit"]);
    check("guard cache hit", /cached/.test(r.stdout) ? 1 : 0, 1);

    fs.writeFileSync(path.join(repo, "docs", "dirty.md"), "# dirty\n\n该方案赋能全链路，闭环彻底解决，已验证。\nagain\n", "utf8");
    git(["add", "-A"], repo);
    r = g(["hook", "pre-commit"]);
    check("guard hook fail closed", r.status, 1);

    r = g(["hook", "pre-commit"], { SIGNOFF_SKIP: "1" });
    check("guard skip allowed", r.status, 0);
    check("guard skip recorded", fs.existsSync(path.join(repo, ".signoff", "skips.log")) ? 1 : 0, 1);

    r = g(["uninstall"]);
    check("guard uninstall", fs.existsSync(path.join(hooks, "pre-commit")) ? 0 : 1, 1);
    r = g(["init", "--dry-run", "--no-ci"]);
    check("guard dry-run writes nothing", fs.existsSync(path.join(hooks, "pre-commit")) ? 0 : 1, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  for (const line of PASS) console.log(`PASS ${line}`);
  for (const line of FAIL) console.log(`FAIL ${line}`);
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  return FAIL.length ? 1 : 0;
}

process.exit(main());

#!/usr/bin/env node
"use strict";
// signoff audit — did the commits that landed actually carry a Signoff trailer?
//
// The pre-commit hook records what it saw in `.signoff/passed` (staged tree + mode)
// and the commit-msg hook turns that record into a `Signoff-Pass:` / `Signoff-Skip:`
// line on the message. `git commit --no-verify` skips both hooks, so that commit
// carries no trailer at all — this command is how that stops being invisible after
// the fact: a trailer only counts when its tree prefix matches the commit's tree.

const fs = require("fs");
const path = require("path");
const core = require("./core");

const DEFAULT_RANGE = "HEAD~1..HEAD";
const TRAILER = /^Signoff-(Pass|Skip): ([0-9a-f]{12})$/;
const SIG_LINE = /^Signoff-(Key|Sig): (.+)$/;
const USAGE = `usage: signoff audit [-h] [--range A..B] [--since-install] [--json] [--strict] [--verify] [--require-signed]

Did the commits that landed carry a Signoff trailer?

options:
  -h, --help       show this help message and exit
  --range A..B     commit range to audit (default: ${DEFAULT_RANGE})
  --since-install  audit from the commit recorded by signoff init
  --json           machine-readable result
  --strict         also fail on Signoff-Skip commits
  --verify         check each commit's Signoff-Sig against its Signoff-Key
                   (slow: one ssh-keygen per commit)
  --require-signed fail when a commit carries no signature at all
`;

function warn(msg) {
  process.stderr.write(`signoff audit: ${msg}\n`);
}

// `.signoff/installed.json` is written by `signoff init`; older repos do not have it.
function installPoint() {
  const top = core.git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const p = path.join(top.out.trim(), ".signoff", "installed.json");
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    return d && typeof d.sha === "string" ? d : null;
  } catch (e) {
    return null;
  }
}

function isAncestor(sha, of) {
  return core.git(["merge-base", "--is-ancestor", sha, of]).code === 0;
}

function run(argv) {
  const args = core.parseArgs(argv || [], { verify: false, requireSigned: false });
  if (args.help || args._.indexOf("-h") !== -1) {
    console.log(USAGE);
    return 0;
  }

  const install = installPoint();
  const sinceInstall = !!args.sinceInstall;
  let range = DEFAULT_RANGE;
  if (sinceInstall) {
    if (!install || !install.sha) {
      if (install && !install.sha) {
        warn("install point has no commit yet (the first bootstrap ran mid-commit)");
        warn("run `signoff init` once more after committing, or audit --range A..B");
      } else {
        warn("no install point recorded (run `signoff init`, or pass --range A..B)");
      }
      return 2;
    }
    // The install point is a commit id. If history was rewritten (rebase, force-push)
    // or this is a different clone, that id is not an ancestor of HEAD and the range
    // silently covers the wrong commits - a wrong audit is worse than a refused one.
    const known = core.git(["cat-file", "-e", `${install.sha}^{commit}`]);
    const anc = known.code === 0 ? core.git(["merge-base", "--is-ancestor", install.sha, "HEAD"]) : { code: 1 };
    if (known.code !== 0 || anc.code !== 0) {
      warn(`install point ${String(install.sha).slice(0, 12)} is not an ancestor of HEAD`);
      warn("history was rewritten or this is another clone; run: signoff init --reset-install");
      warn("(or audit an explicit window with --range A..B)");
      return 2;
    }
    range = `${install.sha}..HEAD`;
  }
  if (args.range !== undefined) {
    if (args.range === true) {
      warn("--range needs a value, e.g. --range HEAD~1..HEAD");
      return 2;
    }
    range = String(args.range);
  }
  const strict = !!args.strict;
  const asJson = !!args.json;

  if (core.git(["rev-parse", "--git-dir"]).code !== 0) {
    warn("not a git repository (run inside a repo)");
    return 2;
  }
  const listed = core.git(["rev-list", range]);
  if (listed.code !== 0) {
    warn(`cannot parse range '${range}' (try --range HEAD~1..HEAD)`);
    return 2;
  }

  const shas = listed.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const counts = { pass: 0, skip: 0, missing: 0 };
  const sigCounts = {};
  const verify = !!args.verify;
  const sigcheck = require("./sign");
  const allowed = verify ? sigcheck.allowedKeys(core.git(["rev-parse", "--show-toplevel"]).out.trim() || process.cwd()) : [];
  const commits = [];
  let merges = 0;

  for (const sha of shas) {
    // A merge has no single staged tree, so it cannot be accountable this way.
    const parents = core.git(["log", "-1", "--format=%P", sha])
      .out.split(/\s+/)
      .filter(Boolean);
    if (parents.length > 1) {
      merges++;
      continue;
    }
    const tree = core.git(["rev-parse", `${sha}^{tree}`]).out.trim().slice(0, 12);
    const body = core.git(["log", "-1", "--format=%B", sha]).out;
    let pass = null;
    let skip = null;
    for (const line of body.split(/\r?\n/)) {
      const m = TRAILER.exec(line.trim());
      if (!m) continue;
      if (m[1] === "Pass") pass = m[2];
      else skip = m[2];
    }
    let state = "missing";
    if (pass !== null && pass === tree) state = "pass";
    else if (skip !== null && skip === tree) state = "skip";
    counts[state]++;
    const entry = { sha, state };
    if (verify) {
      let key = null;
      let sig = null;
      for (const line of body.split(/\r?\n/)) {
        const m = SIG_LINE.exec(line.trim());
        if (!m) continue;
        if (m[1] === "Key") key = m[2].trim();
        else sig = m[2].trim();
      }
      if (state !== "pass") {
        entry.sig = "unsigned";
      } else if (!key || !sig) {
        entry.sig = "unsigned";
      } else {
        const full = core.git(["rev-parse", `${sha}^{tree}`]).out.trim();
        const v = sigcheck.verify(full, key, sig, allowed);
        entry.sig = v.state;
        if (v.reason) entry.why = v.reason;
      }
      sigCounts[entry.sig] = (sigCounts[entry.sig] || 0) + 1;
    }
    commits.push(entry);
  }

  // A missing commit that predates the install point cannot carry a trailer: the guard
  // did not exist yet. Say so instead of leaving the number unexplained.
  let preInstall = 0;
  if (counts.missing > 0 && install && install.sha && !sinceInstall) {
    for (const c of commits) {
      if (c.state !== "missing") continue;
      if (isAncestor(c.sha, install.sha)) preInstall++;
    }
  }

  let ok = counts.missing === 0 && !(strict && counts.skip > 0);
  if (verify) {
    if ((sigCounts["bad-signature"] || 0) > 0) ok = false;
    if (args.requireSigned && (sigCounts.unsigned || 0) > 0) ok = false;
  }

  if (asJson) {
    const payload = { ok, range, strict, counts, skipped_merges: merges, commits };
    if (verify) payload.signatures = sigCounts;
    if (install && install.sha) payload.install = { sha: install.sha, pre_install_missing: preInstall };
    core.json(payload);
  } else {
    for (const c of commits) console.log(`${c.sha.slice(0, 7)} ${c.state}`);
    console.log(
      `audit: ${shas.length} commits, pass=${counts.pass} skip=${counts.skip} ` +
        `missing=${counts.missing} skipped_merges=${merges}`
    );
    if (strict && counts.skip > 0) console.log("audit: strict, so Signoff-Skip commits are failures");
    if (verify) {
      const total = Object.values(sigCounts).reduce((n, v) => n + v, 0);
      const parts = Object.entries(sigCounts).map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`audit: signatures ${parts || "none"} (of ${total} audited)`);
      if (!(sigCounts.verified || 0) && total) {
        console.log("audit: no key matched .signoff/allowed_signers (self-signed is not an identity)");
      }
    }
    if (preInstall > 0) {
      console.log(
        `audit: ${preInstall} of ${counts.missing} missing commit(s) predate the install point ` +
          `(${install.sha.slice(0, 12)}); use --since-install`
      );
    }
  }
  return ok ? 0 : 1;
}

module.exports = { run, USAGE, DEFAULT_RANGE };

#!/usr/bin/env node
"use strict";
// signoff audit — did the commits that landed actually carry a Signoff trailer?
//
// The pre-commit hook records what it saw in `.signoff/passed` (staged tree + mode)
// and the commit-msg hook turns that record into a `Signoff-Pass:` / `Signoff-Skip:`
// line on the message. `git commit --no-verify` skips both hooks, so that commit
// carries no trailer at all — this command is how that stops being invisible after
// the fact: a trailer only counts when its tree prefix matches the commit's tree.

const core = require("./core");

const DEFAULT_RANGE = "HEAD~1..HEAD";
const TRAILER = /^Signoff-(Pass|Skip): ([0-9a-f]{12})$/;
const USAGE = `usage: signoff audit [-h] [--range A..B] [--json] [--strict]

Did the commits that landed carry a Signoff trailer?

options:
  -h, --help       show this help message and exit
  --range A..B     commit range to audit (default: ${DEFAULT_RANGE})
  --json           machine-readable result
  --strict         also fail on Signoff-Skip commits
`;

function warn(msg) {
  process.stderr.write(`signoff audit: ${msg}\n`);
}

function run(argv) {
  const args = core.parseArgs(argv || [], {});
  if (args.help || args._.indexOf("-h") !== -1) {
    console.log(USAGE);
    return 0;
  }

  let range = DEFAULT_RANGE;
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
    commits.push({ sha, state });
  }

  const ok = counts.missing === 0 && !(strict && counts.skip > 0);

  if (asJson) {
    core.json({
      ok,
      range,
      strict,
      counts,
      skipped_merges: merges,
      commits,
    });
  } else {
    for (const c of commits) console.log(`${c.sha.slice(0, 7)} ${c.state}`);
    console.log(
      `audit: ${shas.length} commits, pass=${counts.pass} skip=${counts.skip} ` +
        `missing=${counts.missing} skipped_merges=${merges}`
    );
    if (strict && counts.skip > 0) console.log("audit: strict, so Signoff-Skip commits are failures");
  }
  return ok ? 0 : 1;
}

module.exports = { run, USAGE, DEFAULT_RANGE };

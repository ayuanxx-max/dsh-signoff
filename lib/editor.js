"use strict";
// Editor integration: the gate should be runnable from the window the developer
// already has open, and a failure should land in the Problems panel, not the log.

const fs = require("fs");
const path = require("path");
const core = require("./core");

// The guard prints `[secrets] path:line  rule  match` and `[cov] 42.8% 3/7 file`.
// One matcher per shape; `$signoff-gate` is the aggregate the tasks use.
const MATCHERS = {
  "signoff-secret": {
    owner: "signoff",
    fileLocation: ["relative", "${workspaceFolder}"],
    pattern: [
      {
        regexp: "^\\[secrets\\] (.+?):(\\d+)\\s+(\\S+)\\s+(.*)$",
        file: 1,
        line: 2,
        code: 3,
        message: 4,
      },
    ],
  },
  "signoff-cov": {
    owner: "signoff",
    fileLocation: ["relative", "${workspaceFolder}"],
    severity: "warning",
    pattern: [
      {
        regexp: "^\\[cov\\]\\s+([\\d.]+)%\\s+(\\d+)/(\\d+)\\s+(.+)$",
        file: 4,
        message: 1,
      },
    ],
  },
};

function tasks(signoff) {
  const run = (label, args, matcher, extra) =>
    Object.assign(
      {
        label,
        type: "shell",
        command: signoff,
        args,
        group: "test",
        presentation: { reveal: "always", panel: "dedicated", clear: true },
        problemMatcher: matcher ? [matcher] : [],
      },
      extra || {}
    );
  return {
    version: "2.0.0",
    tasks: [
      run("signoff: guard", ["guard"], "signoff-secret"),
      run("signoff: all gates", ["all"], "signoff-secret"),
      run("signoff: secrets", ["secrets", "--all"], "signoff-secret"),
      run("signoff: coverage", ["cov", "--diff"], "signoff-cov"),
      run("signoff: audit", ["audit", "--verify"], null, { group: "none", problemMatcher: [] }),
      run("signoff: status", ["status"], null, { group: "none", problemMatcher: [] }),
    ],
  };
}

// Merge instead of overwrite: a repo may already have tasks, and losing them is
// not a thing a "make it convenient" flag is allowed to do.
function vscode(root, opts) {
  const o = opts || {};
  const dir = path.join(root, ".vscode");
  const file = path.join(dir, "tasks.json");
  fs.mkdirSync(dir, { recursive: true });
  const wanted = tasks(o.command || "signoff");
  let existing = null;
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      // A tasks.json with comments (jsonc) is not parseable; appending a second
      // tasks.json would be worse than leaving the user's file alone.
      return { ok: false, file, reason: "existing tasks.json is not plain JSON (jsonc?); left untouched" };
    }
  }
  const base = existing && Array.isArray(existing.tasks) ? existing : { version: "2.0.0", tasks: [] };
  const labels = new Set((base.tasks || []).map((t) => t && t.label));
  // Problem matchers live in a user-level file; the task references them by owner
  // name, so the JSON we write stays valid for VS Code as-is.
  for (const t of wanted.tasks) {
    if (!labels.has(t.label)) base.tasks.push(t);
  }
  fs.writeFileSync(file, JSON.stringify(base, null, 2) + "\n", "utf8");
  const matcherFile = path.join(dir, "signoff-problem-matchers.json");
  fs.writeFileSync(matcherFile, JSON.stringify(MATCHERS, null, 2) + "\n", "utf8");
  return { ok: true, file, matcherFile, added: base.tasks.length - (existing ? (existing.tasks || []).length : 0) };
}

module.exports = { vscode, MATCHERS, tasks };

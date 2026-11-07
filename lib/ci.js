"use strict";
// GitHub Actions output.
//
// A gate that prints a paragraph is invisible in a PR: the reviewer sees "job
// failed" and scrolls a log. These helpers turn findings into annotations that
// land on the changed line, and a step summary that survives the run.

const fs = require("fs");

function isCI() {
  return String(process.env.GITHUB_ACTIONS || "").toLowerCase() === "true";
}

// GitHub's workflow-command escaping: % -> %25, CR -> %0D, LF -> %0A. A property
// value additionally escapes , and : .
function escData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escProp(s) {
  return escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// list: [{file, line, rule, message, level}]
function annotate(list) {
  if (!isCI()) return 0;
  let n = 0;
  for (const f of list || []) {
    if (!f || !f.file) continue;
    const level = f.level === "warning" ? "warning" : "error";
    const props = [`file=${escProp(f.file)}`];
    if (f.line) props.push(`line=${Number(f.line)}`);
    if (f.rule) props.push(`title=${escProp("signoff/" + f.rule)}`);
    const msg = f.message || `${f.rule || "signoff"} finding`;
    process.stdout.write(`::${level} ${props.join(",")}::${escData(msg)}\n`);
    n++;
  }
  return n;
}

function summary(md) {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p || !md) return false;
  try {
    fs.appendFileSync(p, String(md).replace(/\r\n/g, "\n") + "\n", "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

function table(rows, headers) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, sep, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

module.exports = { isCI, annotate, summary, table, escData, escProp };

"use strict";

// `signoff explain <gate>` — what a gate checks and how it decides. Kept next to the
// gates themselves so the answer comes from the same repo, not from memory.

const USAGE = `usage: signoff explain [-h] [--json] {p1,p2,p3,p4,p5}`;

const GATES = {
  p1: {
    name: "tests",
    checks: "Runs the repository's own test command and fails if it exits non-zero.",
    decides:
      "Command precedence: .signoff/config.json test_cmd, then package.json scripts.test (npm test --silent), " +
      "then vitest/jest/mocha via npx --no-install, then cargo test, go test ./..., make test, then pytest " +
      "(if a .py file exists under tests/), then python -m unittest discover.",
    fix: "Fix the failing test, or pin the real command: signoff init --lock-test (or --test-cmd \"...\").",
  },
  p2: {
    name: "coverage",
    checks: "Reads the scenario table and counts scenarios and assertions against the thresholds.",
    decides:
      "Fails when scenarios < --min-scenario or assertions < --min-assertions; --strict also fails on " +
      "a scenario that claims success without assertions.",
    fix: "Add the missing scenarios or assertions, or lower the thresholds in .signoff/config.json on purpose.",
  },
  p3: {
    name: "queue",
    checks: "Reads tasks/<id>/card.json statuses and refuses to call work done while cards are not finished.",
    decides: "Fails when a card is missing a status, has an unknown status, or is not done; records the run in .signoff/p3.json.",
    fix: "Finish the card, set its status honestly, or remove the card if the task is gone.",
  },
  p4: {
    name: "ledger",
    checks: "Verifies the append-only ledger: every record hashes its predecessor, and every rollback point still exists.",
    decides: "Fails on a broken hash chain, a missing field, or a rollback commit that is not in the repository.",
    fix: "Do not edit .signoff/audit.log by hand; re-record the action with signoff p4 confirm.",
  },
  p5: {
    name: "anti-slop",
    checks: "Scans added documents for empty claims: TODO/TBD/FIXME placeholders and AI-filler words.",
    decides:
      "Fails on a placeholder outside a word boundary (so \"TODO\" in code comments counts but 待补 inside a " +
      "bigger word does not) and on filler phrases that assert progress without evidence.",
    fix: "Replace the claim with what was actually verified, or delete the placeholder.",
  },
};

function run(argv) {
  const list = argv || [];
  if (list.indexOf("-h") !== -1 || list.indexOf("--help") !== -1) {
    console.log(USAGE);
    return 0;
  }
  // Only `--json` exists here, so the gate is simply the one token that is not a flag.
  const asJson = list.indexOf("--json") !== -1;
  const which = String(list.filter((a) => !String(a).startsWith("-"))[0] || "").toLowerCase();
  if (!GATES[which]) {
    console.error(USAGE);
    return 2;
  }
  const g = GATES[which];
  if (asJson) {
    console.log(JSON.stringify({ gate: which, name: g.name, checks: g.checks, decides: g.decides, fix: g.fix }));
    return 0;
  }
  console.log(`${which} — ${g.name}`);
  console.log(`  checks   ${g.checks}`);
  console.log(`  decides  ${g.decides}`);
  console.log(`  fix      ${g.fix}`);
  return 0;
}

module.exports = { run, USAGE, GATES };

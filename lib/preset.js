"use strict";
// Scenario presets: one flag for the settings that are easy to get wrong.
//
// A preset never pins a runner that the machine may not have; it fills a config
// the repo can edit afterwards, and `signoff doctor` still explains what is missing.

const PRESETS = {
  node: {
    label: "Node / TypeScript",
    budget: 180,
    docs: ["README.md", "docs"],
    coverage: { min: 80 },
    p5: { pack: "both" },
    hint: "test_cmd stays auto-detected so a clone without the script still runs something",
  },
  python: {
    label: "Python",
    budget: 240,
    docs: ["README.md", "docs"],
    coverage: { min: 80 },
    p5: { pack: "both" },
    hint: "python -m pytest -q (override with --lock-test if your suite lives elsewhere)",
  },
  go: {
    label: "Go",
    budget: 300,
    docs: ["README.md", "docs"],
    coverage: null,
    p5: { pack: "en" },
    hint: "go test ./... (Go writes coverage per package, so line coverage is opt-in via --coverage)",
  },
  java: {
    label: "Java / Maven",
    budget: 420,
    docs: ["README.md", "docs"],
    coverage: null,
    p5: { pack: "en" },
    hint: "mvn -q test (Gradle repos: --preset java then edit test_cmd)",
  },
};

function names() {
  return Object.keys(PRESETS);
}

// Mutates cfg; returns notes for the init summary. `--preset` never overwrites a
// value the user set on the same command line.
function apply(cfg, name, explicit) {
  const key = String(name || "").toLowerCase();
  const p = PRESETS[key];
  if (!p) return { ok: false, error: `unknown preset '${name}' (choose from ${names().join(", ")})` };
  const set = explicit || {};
  if (!set.budget) cfg.budget = p.budget;
  if (!set.docs) cfg.docs = p.docs.slice();
  // A preset only proposes coverage; the guard runs it only when the field is set.
  cfg.coverage = p.coverage ? Object.assign({}, p.coverage) : null;
  cfg.p5 = Object.assign({}, p.p5);
  const notes = [
    `  preset    ${key} (${p.label})`,
    `            ${p.hint}`,
    `            p5 pack=${cfg.p5.pack}, budget=${cfg.budget}s, coverage=${cfg.coverage ? cfg.coverage.min + "%" : "off"}`,
  ];
  return { ok: true, notes, preset: key };
}

module.exports = { PRESETS, apply, names };

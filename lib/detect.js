"use strict";
// Detect the command that actually runs this repo's tests.
//
// The point is not to guess cleverly; it is to never stay silent. A repo with a
// `tests/` folder but no installed runner used to print "not detected (p1 will be
// skipped)", which reads like a pass. `detect()` therefore returns a hint when it
// found tests but no way to run them, and callers show that hint.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

// A python that can import pytest, in the same order the gates use: SIGNOFF_PYTHON,
// then `python3`/`python`/`py -3`, then the usual Windows install locations.
function pythonCandidates() {
  const out = [];
  if (process.env.SIGNOFF_PYTHON) out.push(process.env.SIGNOFF_PYTHON);
  out.push("python3", "python", "py");
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    if (home) {
      out.push(path.join(home, ".openviking", "venv", "Scripts", "python.exe"));
    }
  }
  return out;
}

function hasPytest() {
  for (const exe of pythonCandidates()) {
    const args = exe === "py" ? ["-3", "-c", "import pytest"] : ["-c", "import pytest"];
    const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true });
    if (r.status === 0) return exe === "py" ? "py -3" : exe;
  }
  return null;
}

const PY_TEST = /(^test_.*\.py$|.*_test\.py$)/;

function hasPythonTests(root) {
  // An empty `tests/` folder is not a suite: require at least one python file under it,
  // otherwise every scaffold prints "pytest" and p1 fails with "no tests ran".
  let underTests = false;
  const scanTests = (dir, depth) => {
    if (depth > 2 || underTests) return;
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of list) {
      if (e.isFile() && e.name.endsWith(".py")) underTests = true;
      else if (e.isDirectory()) scanTests(path.join(dir, e.name), depth + 1);
    }
  };
  if (isDir(path.join(root, "tests"))) scanTests(path.join(root, "tests"), 0);
  if (underTests) return true;
  let hits = 0;
  const walk = (dir, depth) => {
    if (depth > 3 || hits > 0) return;
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of list) {
      if (hits > 0) return;
      if (e.name === "node_modules" || e.name === ".git" || e.name === "venv" || e.name === ".venv") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (PY_TEST.test(e.name)) hits += 1;
    }
  };
  walk(root, 0);
  return hits > 0;
}

function hasTarget(file, target) {
  try {
    return new RegExp("^" + target + "\\s*:", "m").test(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return false;
  }
}

// Returns {cmd, source, hint}. `cmd` runs the suite; `hint` explains why there is no
// command even though something looked testable. Both null means "nothing here".
function detect(root, cfg) {
  cfg = cfg || {};
  if (cfg.test_cmd) return { cmd: String(cfg.test_cmd), source: "signoff config", hint: "" };

  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    const scripts = pkg.scripts || {};
    if (scripts.test && !String(scripts.test).includes("no test specified")) {
      return { cmd: "npm test --silent", source: "package.json scripts.test", hint: "" };
    }
    // A known runner in the dependency list beats a missing npm script: `npx --no-install`
    // fails loudly instead of downloading something unrelated.
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    for (const [name, cmd] of [
      ["vitest", "npx --no-install vitest run"],
      ["jest", "npx --no-install jest"],
      ["mocha", "npx --no-install mocha"],
    ]) {
      if (deps[name]) return { cmd, source: name, hint: "" };
    }
  }

  if (exists(path.join(root, "Cargo.toml"))) return { cmd: "cargo test --quiet", source: "Cargo.toml", hint: "" };
  if (exists(path.join(root, "go.mod"))) return { cmd: "go test ./...", source: "go.mod", hint: "" };
  for (const name of ["Makefile", "makefile"]) {
    if (hasTarget(path.join(root, name), "test")) return { cmd: "make test", source: name, hint: "" };
  }

  if (hasPythonTests(root)) {
    const py = hasPytest();
    if (py) return { cmd: `"${py}" -m pytest -q`, source: "pytest", hint: "" };
    // unittest discovery needs no dependency and covers `tests/test_*.py`.
    for (const exe of pythonCandidates()) {
      const args = exe === "py" ? ["-3", "-c", "import sys"] : ["-c", "import sys"];
      if (spawnSync(exe, args, { encoding: "utf8", windowsHide: true }).status === 0) {
        return { cmd: `"${exe}" -m unittest discover -q`, source: "unittest (pytest not installed)", hint: "" };
      }
    }
    return {
      cmd: null,
      source: "",
      hint: "python tests found but no python interpreter; install one or set --test-cmd",
    };
  }
  return { cmd: null, source: "", hint: "" };
}

// One line for `init` / `status`: what will run, or why nothing will.
function describe(root, cfg) {
  const d = detect(root, cfg);
  if (d.cmd) return `${d.cmd}  (${d.source})`;
  if (d.hint) return d.hint;
  return "none (nothing testable found; p1 is skipped)";
}

module.exports = { detect, describe, pythonCandidates, hasPytest };

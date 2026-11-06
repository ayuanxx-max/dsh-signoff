#!/usr/bin/env python3
"""Self-test for dsh-signoff: every gate is run against a throwaway repo and the
exit code is the assertion. Run with `python test/selftest.py`.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATES = ROOT / "gates"
PASS, FAIL = [], []


def check(name: str, got: int, want: int, extra: str = "") -> None:
    (PASS if got == want else FAIL).append(f"{name}: rc={got} want={want} {extra}")


def gate(name: str, *args: str, cwd: Path, home: Path | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["SIGNOFF_HOME"] = str(home or (cwd / ".signoff-home"))
    return subprocess.run(
        [sys.executable, str(GATES / name), *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        errors="replace",
        env=env,
    )


def build_repo(base: Path) -> Path:
    repo = base / "repo"
    (repo / "tests").mkdir(parents=True)
    (repo / "verify" / "scenarios").mkdir(parents=True)
    (repo / "docs").mkdir()
    (repo / "tasks" / "t1").mkdir(parents=True)
    (repo / "tasks" / "t2").mkdir(parents=True)
    (repo / "tests" / "test_ok.py").write_text("def test_ok():\n    assert True\n", encoding="utf-8")
    (repo / "verify" / "scenarios" / "a.json").write_text(
        json.dumps({"checks": [{"name": "x"}, {"name": "y"}, {"name": "z"}]}), encoding="utf-8"
    )
    (repo / "package.json").write_text('{"name": "fixture", "version": "0.0.0"}\n', encoding="utf-8")
    (repo / "tasks" / "t1" / "card.json").write_text(
        json.dumps({"id": "t1", "goal": "g", "scope": ["src/a/**"], "acceptance": ["pass"], "rollback": "HEAD"}),
        encoding="utf-8",
    )
    (repo / "tasks" / "t2" / "card.json").write_text(
        json.dumps({"id": "t2", "goal": "g", "scope": ["src/a/b.py"], "acceptance": ["pass"], "rollback": "HEAD"}),
        encoding="utf-8",
    )
    (repo / "docs" / "clean.md").write_text("# clean\n\n40 cases in 3.6 s, 12/12 PASS.\n", encoding="utf-8")
    (repo / "docs" / "dirty.md").write_text(
        "# dirty\n\n这个方案赋能全链路，闭环彻底解决，已验证。\n", encoding="utf-8"
    )
    subprocess.run(["git", "init", "-q"], cwd=str(repo), check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=str(repo), check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=str(repo), check=True)
    subprocess.run(["git", "add", "-A"], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=str(repo), check=True)
    return repo


def main() -> int:
    base = Path(tempfile.mkdtemp(prefix="signoff-selftest-"))
    try:
        repo = build_repo(base)
        home = base / "home"

        # P1 - passing command, parsed case count; then a failing command.
        r = gate("p1_verify.py", "--run", f'"{sys.executable}" -c "print(\'3 passed\')"', cwd=repo, home=home)
        check("p1 pass", r.returncode, 0, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "")
        p1 = json.loads((repo / ".signoff" / "p1.json").read_text(encoding="utf-8"))
        check("p1 cases parsed", p1["cases"], 3, str(p1["cases"]))
        r = gate("p1_verify.py", "--run", f'"{sys.executable}" -c "raise SystemExit(1)"', cwd=repo, home=home)
        check("p1 fail on rc!=0", r.returncode, 1)

        # P2 - one scenario app with three assertions; strict still passes.
        r = gate("p2_coverage.py", "--strict", "--json", cwd=repo, home=home)
        check("p2 pass", r.returncode, 0, r.stdout.strip())
        r = gate("p2_coverage.py", "--min-assertions", "9", cwd=repo, home=home)
        check("p2 fail on threshold", r.returncode, 1)

        # P3 - overlapping scopes land in different waves; unowned change is red.
        r = gate("p3_queue.py", "validate", cwd=repo, home=home)
        check("p3 validate", r.returncode, 0, r.stdout.strip())
        r = gate("p3_queue.py", "plan", cwd=repo, home=home)
        check("p3 plan splits", r.returncode, 0)
        waves = json.loads((repo / ".signoff" / "p3.json").read_text(encoding="utf-8"))["waves"]
        check("p3 wave count", len(waves), 2, str(waves))
        r = gate("p3_queue.py", "collect", "--changed", "src/a/b.py", "stray.txt", cwd=repo, home=home)
        check("p3 unowned red", r.returncode, 1)

        # P4 - ticket -> allow -> verify; then tamper and deny.
        r = gate("p4_ledger.py", "ask", "--action", "publish", "--target", "demo@1.0.0", cwd=repo, home=home)
        check("p4 ask", r.returncode, 0, r.stdout.strip().splitlines()[0])
        token = r.stdout.split("ticket ")[1].split()[0]
        r = gate("p4_ledger.py", "confirm", "--ticket", token, "--decision", "allow", "--detail", "d", "--rollback", "HEAD", cwd=repo, home=home)
        check("p4 confirm allow", r.returncode, 0, r.stdout.strip())
        r = gate("p4_ledger.py", "verify", cwd=repo, home=home)
        check("p4 verify ok", r.returncode, 0, r.stdout.strip())
        r = gate("p4_ledger.py", "confirm", "--ticket", token, "--decision", "allow", cwd=repo, home=home)
        check("p4 ticket single-use", r.returncode, 2)
        log = home / "audit.log"
        log.write_text(log.read_text(encoding="utf-8").replace('"d"', '"tampered"'), encoding="utf-8")
        r = gate("p4_ledger.py", "verify", cwd=repo, home=home)
        check("p4 tamper detected", r.returncode, 1, r.stdout.strip())
        # free-text rollback must be refused
        r = gate("p4_ledger.py", "ask", "--action", "publish", "--target", "x", cwd=repo, home=home)
        token = r.stdout.split("ticket ")[1].split()[0]
        gate("p4_ledger.py", "confirm", "--ticket", token, "--decision", "allow", "--rollback", "npm deprecate x", cwd=repo, home=home)
        r = gate("p4_ledger.py", "verify", cwd=repo, home=home)
        check("p4 fake rollback refused", r.returncode, 1, r.stdout.strip())

        # P5 - dirty doc red, clean doc green.
        r = gate("p5_slop.py", "docs/dirty.md", cwd=repo, home=home)
        check("p5 dirty red", r.returncode, 1, r.stdout.strip().splitlines()[-1])
        r = gate("p5_slop.py", "docs/clean.md", cwd=repo, home=home)
        check("p5 clean green", r.returncode, 0, r.stdout.strip().splitlines()[-1])

        # Guard - install once, then the gates run themselves.
        ghome = base / "guard-home"  # its own ledger: p4 stays out of this section

        def guard(*a, extra=None):
            env = dict(os.environ)
            env["SIGNOFF_HOME"] = str(ghome)
            env.pop("SIGNOFF_SKIP", None)
            if extra:
                env.update(extra)
            return subprocess.run(
                [sys.executable, str(GATES / "guard.py"), *a],
                cwd=str(repo),
                capture_output=True,
                text=True,
                errors="replace",
                env=env,
            )

        r = guard("init", "--no-ci")
        check("guard init", r.returncode, 0, r.stdout.strip().splitlines()[0] if r.stdout.strip() else "")
        hooks = repo / ".git" / "hooks"
        check("guard pre-commit hook", 1 if (hooks / "pre-commit").exists() else 0, 1)
        check("guard pre-push hook", 1 if (hooks / "pre-push").exists() else 0, 1)
        check("guard config", 1 if (repo / ".signoff" / "config.json").exists() else 0, 1)
        check("guard gitignore", 1 if ".signoff/" in (repo / ".gitignore").read_text(encoding="utf-8") else 0, 1)
        r = guard("status", "--json")
        check("guard status", 1 if json.loads(r.stdout)["installed"]["pre-commit"] else 0, 1)

        (repo / "docs" / "clean.md").write_text(
            "# clean\n\n40 cases in 3.6 s, 12/12 PASS.\nsecond line\n", encoding="utf-8"
        )
        subprocess.run(["git", "add", "-A"], cwd=str(repo), check=True)
        r = guard("hook", "pre-commit")
        check("guard hook pass", r.returncode, 0, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "")
        r = guard("hook", "pre-commit")
        check("guard cache hit", 1 if "cached" in r.stdout else 0, 1)

        (repo / "docs" / "dirty.md").write_text(
            "# dirty\n\n这个方案赋能全链路，闭环彻底解决，已验证。\nagain\n", encoding="utf-8"
        )
        subprocess.run(["git", "add", "-A"], cwd=str(repo), check=True)
        r = guard("hook", "pre-commit")
        check("guard hook fail closed", r.returncode, 1, "")

        r = guard("hook", "pre-commit", extra={"SIGNOFF_SKIP": "1"})
        check("guard skip allowed", r.returncode, 0, r.stdout.strip())
        check("guard skip recorded", 1 if (repo / ".signoff" / "skips.log").exists() else 0, 1)

        r = guard("uninstall")
        check("guard uninstall", 1 if not (hooks / "pre-commit").exists() else 0, 1)
        r = guard("init", "--dry-run", "--no-ci")
        check("guard dry-run writes nothing", 1 if not (hooks / "pre-commit").exists() else 0, 1)
    finally:
        shutil.rmtree(base, ignore_errors=True)

    for line in PASS:
        print(f"PASS {line}")
    for line in FAIL:
        print(f"FAIL {line}")
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    raise SystemExit(main())

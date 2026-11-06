#!/usr/bin/env python3
"""SignOff gate 1 - verify before you speak.

Runs the project's own checks, times them, parses the case count and writes
.signoff/p1.json. Exit code is the verdict: 0 only when every command passed
inside the time budget. Output is ASCII on purpose: a GBK console must not be
able to turn a real PASS into mojibake.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path.cwd()
OUT = ROOT / ".signoff"


def default_commands() -> list[str]:
    if (ROOT / "tests").is_dir():
        return [f'"{sys.executable}" -m pytest tests -q']
    if (ROOT / "package.json").exists():
        return ["npm test --silent"]
    return []


def count_cases(text: str) -> int | None:
    for pat in (r"(\d+)\s+passed", r"(\d+)\s+tests?\b", r"(\d+)\s+checks?\b", r"(\d+)\s+assertions?\b"):
        hits = re.findall(pat, text)
        if hits:
            return max(int(h) for h in hits)
    return None


def install_hook() -> int:
    hooks = ROOT / ".git" / "hooks"
    if not hooks.is_dir():
        print("[p1] not a git repository (no .git/hooks)")
        return 2
    hook = hooks / "pre-commit"
    hook.write_text("#!/bin/sh\n# installed by SignOff / dsh-signoff\nexec signoff p1\n", encoding="utf-8")
    try:
        hook.chmod(0o755)
    except OSError:
        pass
    print(f"[p1] hook installed: {hook}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="signoff p1")
    ap.add_argument("--run", action="append", default=[], help="command to run (repeatable)")
    ap.add_argument("--budget", type=float, default=180.0, help="seconds for all commands together")
    ap.add_argument("--install-hook", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    if a.install_hook:
        return install_hook()

    cmds = a.run or default_commands()
    if not cmds:
        print("[p1] nothing to run: no tests/ and no package.json")
        return 2

    started = time.perf_counter()
    results = []
    for cmd in cmds:
        t0 = time.perf_counter()
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, errors="replace")
        ms = round((time.perf_counter() - t0) * 1000)
        out = (proc.stdout or "") + (proc.stderr or "")
        results.append(
            {
                "cmd": cmd,
                "rc": proc.returncode,
                "ms": ms,
                "cases": count_cases(out),
                "tail": out.strip().splitlines()[-3:],
            }
        )
        if not a.quiet:
            print(f"[p1] rc={proc.returncode} {ms} ms  {cmd}")

    elapsed = round((time.perf_counter() - started) * 1000)
    ok = all(r["rc"] == 0 for r in results) and elapsed <= a.budget * 1000
    total_cases = sum(r["cases"] or 0 for r in results)
    payload = {
        "gate": "p1",
        "ok": ok,
        "elapsedMs": elapsed,
        "budgetMs": int(a.budget * 1000),
        "cases": total_cases,
        "results": results,
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "p1.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if a.json:
        print(json.dumps({k: payload[k] for k in ("gate", "ok", "elapsedMs", "budgetMs", "cases")}, ensure_ascii=False))
    else:
        print(f"[p1] {'PASS' if ok else 'FAIL'} {elapsed} ms (budget {int(a.budget * 1000)} ms), cases={total_cases}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

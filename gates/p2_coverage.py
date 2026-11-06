#!/usr/bin/env python3
"""SignOff gate 2 - coverage has a level, not a vibe.

Walks app directories, reads verify/scenarios/*.json, counts real assertions and
assigns one of four levels (scenario / harness / smoke / missing). "There is a
dev page" is not coverage; a scenario with N checks is.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path.cwd()
OUT = ROOT / ".signoff"
LEVELS = {"missing": 0, "smoke": 1, "harness": 2, "scenario": 3}


def app_dirs() -> list[Path]:
    found = []
    if (ROOT / "package.json").exists() or (ROOT / "verify").is_dir():
        found.append(ROOT)
    for base in (ROOT, ROOT / "packages", ROOT / "apps"):
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir()):
            if not d.is_dir() or d.name.startswith(".") or d.name in {"node_modules", "docs", "gates", "bin", "test"}:
                continue
            if (d / "package.json").exists() or (d / "verify").is_dir():
                found.append(d)
    return found


def scenario_checks(path: Path) -> int:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return -1
    checks = data.get("checks")
    return len(checks) if isinstance(checks, list) else -1


def inspect(app: Path) -> dict:
    sdir = app / "verify" / "scenarios"
    scenarios = []
    if sdir.is_dir():
        for f in sorted(sdir.glob("*.json")):
            scenarios.append({"file": f.name, "checks": scenario_checks(f)})
    broken = [s for s in scenarios if s["checks"] < 0]
    if scenarios and not broken:
        level = "scenario"
    elif (app / "verify").is_dir():
        level = "harness"
    elif (app / "package.json").exists():
        level = "smoke"
    else:
        level = "missing"
    assertions = sum(s["checks"] for s in scenarios if s["checks"] > 0)
    return {
        "app": app.name,
        "level": level,
        "scenarios": scenarios,
        "assertions": assertions,
        "broken": [s["file"] for s in broken],
    }


def main() -> int:
    ap = argparse.ArgumentParser(prog="signoff p2")
    ap.add_argument("--min-scenario", type=int, default=0, help="require at least N scenario-level apps")
    ap.add_argument("--min-assertions", type=int, default=0)
    ap.add_argument("--strict", action="store_true", help="fail on missing/harness/broken")
    ap.add_argument("--md", metavar="FILE", help="write a markdown table")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    apps = app_dirs()
    rows = [inspect(d) for d in apps]
    scenario_apps = [r for r in rows if r["level"] == "scenario"]
    assertions = sum(r["assertions"] for r in rows)
    broken = [r for r in rows if r["broken"]]
    ok = (
        len(scenario_apps) >= a.min_scenario
        and assertions >= a.min_assertions
        and not broken
        and (not a.strict or all(r["level"] == "scenario" for r in rows))
    )

    header = f"{'app':34} {'level':9} {'scenarios':22} assertions"
    lines = [header, "-" * len(header)]
    for r in rows:
        names = ", ".join(f"{s['file'][:-5]}({s['checks']})" for s in r["scenarios"]) or "-"
        lines.append(f"{r['app'][:33]:34} {r['level']:9} {names[:21]:22} {r['assertions']}")

    if a.md:
        md = ["| app | level | scenarios | assertions |", "| --- | --- | --- | --- |"]
        for r in rows:
            names = ", ".join(f"{s['file'][:-5]}({s['checks']})" for s in r["scenarios"]) or "-"
            md.append(f"| {r['app']} | {r['level']} | {names} | {r['assertions']} |")
        Path(a.md).write_text("\n".join(md) + "\n", encoding="utf-8")
        lines.append(f"[p2] table written: {a.md}")

    payload = {
        "gate": "p2",
        "ok": ok,
        "apps": len(rows),
        "scenarioApps": len(scenario_apps),
        "assertions": assertions,
        "broken": [{"app": b["app"], "files": b["broken"]} for b in broken],
        "rows": rows,
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "p2.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if a.json:
        print(json.dumps({k: payload[k] for k in ("gate", "ok", "apps", "scenarioApps", "assertions")}, ensure_ascii=False))
    else:
        print("\n".join(lines))
        print(
            f"[p2] {'PASS' if ok else 'FAIL'} apps={len(rows)} scenario={len(scenario_apps)} assertions={assertions} broken={len(broken)}"
        )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

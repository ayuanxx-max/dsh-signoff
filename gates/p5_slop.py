#!/usr/bin/env python3
"""SignOff gate 5 - empty words are a failure.

Six rules over markdown. Code fences and table rows are skipped so a legitimate
example cannot be reported as slop; the point is documents that claim progress
without a number behind it.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path.cwd()
OUT = ROOT / ".signoff"

AI_WORDS = (
    "赋能", "闭环", "抓手", "颗粒度", "底层逻辑", "组合拳", "全链路", "护城河",
    "打通", "沉淀", "体系化", "复用", "生态位", "范式", "维度上", "协同增效",
)
ABSOLUTE = ("100%", "零缺陷", "永不", "绝对", "完美", "彻底", "极致", "无缝", "彻底解决")
ADVERBS = ("极其", "非常", "十分", "相当", "大幅")
CLAIMS = re.compile(r"(已验证|已覆盖|全部通过|全绿|都验证过)")
PLACEHOLDER = re.compile(r"\b(TODO|TBD|FIXME)\b|待补|待定")


def scan(text: str) -> list[tuple[str, int, str]]:
    hits: list[tuple[str, int, str]] = []
    in_fence = False
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or line.startswith("|") or not line:
            continue
        # A document may legitimately quote a banned word: `赋能` in backticks is
        # an example, not a claim.
        line = re.sub(r"`[^`]*`", "", line).strip()
        if not line:
            continue
        if PLACEHOLDER.search(line):
            hits.append(("placeholder", n, "unfinished marker"))
        for w in AI_WORDS:
            if w in line:
                hits.append(("ai-word", n, w))
        for w in ABSOLUTE:
            if w in line:
                hits.append(("absolute-claim", n, w))
        if CLAIMS.search(line) and not re.search(r"\d", line):
            hits.append(("claim-without-number", n, "verification claim with no figure"))
        adverbs = sum(line.count(w) for w in ADVERBS)
        if adverbs >= 2:
            hits.append(("empty-adverbs", n, f"{adverbs} intensifiers in one line"))
    counts: dict[str, int] = {}
    for kind, _, word in hits:
        if kind in ("ai-word", "empty-adverbs"):
            counts[word] = counts.get(word, 0) + 1
    return hits


def targets(args: list[str]) -> list[Path]:
    if args:
        out = []
        for a in args:
            p = Path(a)
            if p.is_dir():
                out.extend(sorted(p.rglob("*.md")))
            elif p.exists():
                out.append(p)
        return out
    found = [ROOT / "README.md", ROOT / "CHANGELOG.md"]
    if (ROOT / "docs").is_dir():
        found.extend(sorted((ROOT / "docs").rglob("*.md")))
    return [p for p in found if p.exists()]


def main() -> int:
    ap = argparse.ArgumentParser(prog="signoff p5")
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--allow", action="append", default=[], help="rule id to ignore")
    a = ap.parse_args()

    files = targets(a.paths)
    report = []
    for f in files:
        hits = [h for h in scan(f.read_text(encoding="utf-8", errors="replace")) if h[0] not in a.allow]
        rel = str(f.relative_to(ROOT)) if f.is_relative_to(ROOT) else str(f)
        for kind, line, word in hits:
            report.append({"file": rel, "line": line, "rule": kind, "hit": word})

    ok = not report
    payload = {"gate": "p5", "ok": ok, "files": len(files), "hits": report}
    OUT.mkdir(exist_ok=True)
    (OUT / "p5.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if a.json:
        print(json.dumps({"gate": "p5", "ok": ok, "files": len(files), "hits": len(report)}, ensure_ascii=False))
    else:
        for h in report:
            print(f"[p5] {h['file']}:{h['line']}  {h['rule']}  {h['hit']}")
        print(f"[p5] {'PASS' if ok else 'FAIL'} files={len(files)} hits={len(report)}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

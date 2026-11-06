#!/usr/bin/env python3
"""SignOff gate 3 - parallel work, no collisions.

A task card says what a worker may touch, what proves it done and where the
rollback point is. `plan` turns a pile of cards into waves: cards whose scopes
overlap never share a wave. `collect` checks the diff back against the scopes and
names both kinds of failure - a file nobody owns, and a card that shipped nothing.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path.cwd()
OUT = ROOT / ".signoff"
REQUIRED = ("id", "goal", "scope", "acceptance", "rollback")


def load_cards(cards_dir: Path) -> list[dict]:
    cards = []
    for f in sorted(cards_dir.rglob("card.json")) if cards_dir.is_dir() else []:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            cards.append({"id": str(f), "broken": f"unreadable: {exc}"})
            continue
        data["_file"] = str(f.relative_to(ROOT)) if f.is_relative_to(ROOT) else str(f)
        cards.append(data)
    return cards


def validate(cards: list[dict]) -> list[str]:
    problems: list[str] = []
    seen: dict[str, str] = {}
    for c in cards:
        cid = c.get("id", "?")
        if c.get("broken"):
            problems.append(f"{cid}: {c['broken']}")
            continue
        for key in REQUIRED:
            if not c.get(key):
                problems.append(f"{cid}: missing '{key}'")
        scope = c.get("scope")
        if isinstance(scope, list):
            for pat in scope:
                if not isinstance(pat, str) or not pat.strip():
                    problems.append(f"{cid}: bad scope entry {pat!r}")
        elif "scope" in c:
            problems.append(f"{cid}: scope must be a list")
        if cid in seen:
            problems.append(f"duplicate id {cid} ({seen[cid]} vs {c['_file']})")
        seen[cid] = c.get("_file", "")
    return problems


def prefix(glob: str) -> str:
    for i, ch in enumerate(glob):
        if ch in "*?[":
            return glob[:i].rstrip("/\\")
    return glob.rstrip("/\\")


def conflicts(a: dict, b: dict) -> bool:
    for pa in a.get("scope") or []:
        for pb in b.get("scope") or []:
            if pa == pb:
                return True
            fa, fb = prefix(pa).replace("\\", "/"), prefix(pb).replace("\\", "/")
            if not fa or not fb:
                return True
            if fa.startswith(fb) or fb.startswith(fa):
                return True
    return False


def plan(cards: list[dict]) -> list[dict]:
    waves: list[list[dict]] = []
    for card in cards:
        if card.get("broken"):
            continue
        placed = False
        for wave in waves:
            if not any(conflicts(card, other) for other in wave):
                wave.append(card)
                placed = True
                break
        if not placed:
            waves.append([card])
    return waves


def card_owns(card: dict, path: str) -> bool:
    path = path.replace("\\", "/")
    for pat in card.get("scope") or []:
        pat = pat.replace("\\", "/")
        if fnmatch.fnmatch(path, pat) or path == prefix(pat):
            return True
        pre = prefix(pat)
        if pre and path.startswith(pre.rstrip("/") + "/"):
            return True
    return False


def git_changed() -> list[str]:
    files: list[str] = []
    for args in (["git", "diff", "--name-only", "HEAD"], ["git", "ls-files", "--others", "--exclude-standard"]):
        try:
            r = subprocess.run(args, capture_output=True, text=True, errors="replace")
        except OSError:
            continue
        if r.returncode == 0:
            files.extend([ln.strip() for ln in r.stdout.splitlines() if ln.strip()])
    return sorted(set(files))


def main() -> int:
    ap = argparse.ArgumentParser(prog="signoff p3")
    ap.add_argument("cmd", choices=["validate", "plan", "collect"])
    ap.add_argument("--cards", default="tasks")
    ap.add_argument("--changed", nargs="*", default=None)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    cards = load_cards(ROOT / a.cards)
    problems = validate(cards)

    if a.cmd == "validate":
        ok = not problems
        payload = {"gate": "p3", "cmd": "validate", "ok": ok, "cards": len(cards), "problems": problems}
        OUT.mkdir(exist_ok=True)
        (OUT / "p3.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if a.json:
            print(json.dumps({k: payload[k] for k in ("gate", "cmd", "ok", "cards")}, ensure_ascii=False))
        else:
            for p in problems:
                print(f"[p3] {p}")
            print(f"[p3] {'PASS' if ok else 'FAIL'} cards={len(cards)} problems={len(problems)}")
        return 0 if ok else 1

    if a.cmd == "plan":
        waves = plan(cards)
        ok = not problems and bool(waves)
        payload = {"gate": "p3", "cmd": "plan", "ok": ok, "waves": [[c.get("id") for c in w] for w in waves], "problems": problems}
        OUT.mkdir(exist_ok=True)
        (OUT / "p3.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if a.json:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            for i, wave in enumerate(waves, 1):
                print(f"[p3] wave {i}: " + ", ".join(c.get("id", "?") for c in wave))
            print(f"[p3] {'PASS' if ok else 'FAIL'} waves={len(waves)} cards={len(cards)}")
        return 0 if ok else 1

    changed = a.changed if a.changed is not None else git_changed()
    owners = {f: [c.get("id") for c in cards if not c.get("broken") and card_owns(c, f)] for f in changed}
    unowned = [f for f, ids in owners.items() if not ids]
    missing = [c.get("id") for c in cards if not c.get("broken") and not any(card_owns(c, f) for f in changed)]
    ok = not problems and not unowned
    payload = {
        "gate": "p3",
        "cmd": "collect",
        "ok": ok,
        "changed": len(changed),
        "unowned": unowned,
        "cardsWithoutChange": missing,
        "problems": problems,
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "p3.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if a.json:
        print(json.dumps({k: payload[k] for k in ("gate", "cmd", "ok", "changed")}, ensure_ascii=False))
    else:
        for f in unowned:
            print(f"[p3] unowned change: {f}")
        for cid in missing:
            print(f"[p3] card shipped nothing: {cid}")
        print(f"[p3] {'PASS' if ok else 'FAIL'} changed={len(changed)} unowned={len(unowned)} empty={len(missing)}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""SignOff gate 4 - risky actions leave a ledger.

Three categories are gated: config, profile, publish. A ticket is minted first
(`ask`), it is single-use and expires, and only then does `confirm` append a
hash-chained entry carrying the rollback point. `verify` recomputes the chain and
checks that every rollback point still exists - a free-text rollback is rejected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import subprocess
import time
from pathlib import Path

ACTIONS = ("config", "profile", "publish")
HOME = Path(os.environ.get("SIGNOFF_HOME") or (Path.home() / ".signoff"))
LOG = HOME / "audit.log"
TICKETS = HOME / "tickets"


def entries() -> list[dict]:
    if not LOG.exists():
        return []
    out = []
    for line in LOG.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def digest(prev: str, body: dict) -> str:
    payload = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256((prev + payload).encode("utf-8")).hexdigest()


def git_describe() -> str:
    try:
        r = subprocess.run(["git", "describe", "--tags", "--always"], capture_output=True, text=True, errors="replace")
        return r.stdout.strip() if r.returncode == 0 else "no-git"
    except OSError:
        return "no-git"


def ask(action: str, target: str, ttl: int) -> int:
    TICKETS.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(4)
    (TICKETS / f"{token}.json").write_text(
        json.dumps({"token": token, "action": action, "target": target, "expires": time.time() + ttl}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"ticket {token}  action={action}  target={target}  ttl={ttl}s")
    print(f'confirm with: signoff p4 confirm --ticket {token} --decision allow --detail "..."')
    return 0


def confirm(ticket: str, decision: str, detail: str, rollback: str) -> int:
    path = TICKETS / f"{ticket}.json"
    if not path.exists():
        print(f"[p4] unknown or already used ticket {ticket}")
        return 2
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print(f"[p4] unreadable ticket {ticket}")
        return 2
    if meta.get("expires", 0) < time.time():
        path.unlink(missing_ok=True)
        print(f"[p4] ticket {ticket} expired")
        return 2
    path.unlink(missing_ok=True)

    chain = entries()
    prev = chain[-1]["hash"] if chain else "genesis"
    body = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "action": meta["action"],
        "target": meta.get("target", ""),
        "detail": detail,
        "rollback": rollback,
        "decision": decision,
    }
    record = dict(body, prev=prev, hash=digest(prev, body))
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    print(json.dumps({"ok": decision == "allow", "hash": record["hash"], "rollback": rollback}, ensure_ascii=False))
    return 0 if decision == "allow" else 1


def verify() -> int:
    chain = entries()
    problems: list[str] = []
    prev = "genesis"
    for i, rec in enumerate(chain, 1):
        body = {k: rec.get(k) for k in ("ts", "action", "target", "detail", "rollback", "decision")}
        if rec.get("prev") != prev:
            problems.append(f"line {i}: prev hash mismatch")
        if rec.get("hash") != digest(prev, body):
            problems.append(f"line {i}: content hash mismatch (edited after the fact)")
        prev = rec.get("hash", "")
        rb = rec.get("rollback") or ""
        if not rb:
            problems.append(f"line {i}: no rollback point recorded")
        elif rb != "no-git":
            if " " in rb:
                problems.append(f"line {i}: rollback point '{rb}' is not a git ref")
            else:
                try:
                    r = subprocess.run(["git", "rev-parse", "--verify", "--quiet", rb], capture_output=True, text=True, errors="replace")
                except OSError:
                    r = None
                if r is not None and r.returncode != 0:
                    problems.append(f"line {i}: rollback point '{rb}' no longer exists")
    print(json.dumps({"ok": not problems, "entries": len(chain), "problems": problems}, ensure_ascii=False))
    return 0 if not problems else 1


def export(out: str) -> int:
    chain = entries()
    lines = ["# SignOff ledger", "", "| # | action | target | decision | rollback | hash |", "| --- | --- | --- | --- | --- | --- |"]
    for i, r in enumerate(chain, 1):
        lines.append(
            f"| {i} | {r.get('action','')} | {r.get('target','')} | {r.get('decision','')} | {r.get('rollback','')} | {str(r.get('hash',''))[:12]} |"
        )
    Path(out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[p4] {len(chain)} entries written to {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="signoff p4")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("ask")
    a.add_argument("--action", choices=ACTIONS, required=True)
    a.add_argument("--target", default="")
    a.add_argument("--ttl", type=int, default=600)

    c = sub.add_parser("confirm")
    c.add_argument("--ticket", required=True)
    c.add_argument("--decision", choices=["allow", "deny"], default="allow")
    c.add_argument("--detail", default="")
    c.add_argument("--rollback", default=None)

    sub.add_parser("verify")

    e = sub.add_parser("export")
    e.add_argument("--out", default="docs/signoff-ledger.md")

    args = ap.parse_args()
    if args.cmd == "ask":
        return ask(args.action, args.target, args.ttl)
    if args.cmd == "confirm":
        return confirm(args.ticket, args.decision, args.detail, args.rollback or git_describe())
    if args.cmd == "verify":
        return verify()
    return export(args.out)


if __name__ == "__main__":
    raise SystemExit(main())

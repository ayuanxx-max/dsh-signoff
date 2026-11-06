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
BODY_KEYS_V1 = ("ts", "action", "target", "detail", "rollback", "decision")
# 3.3.0 records also hash their repository; pre-3.3.0 records have no `repo` key and keep
# verifying under the v1 tuple. Mirrors lib/p4.js so the two engines stay byte-compatible.
BODY_KEYS_V2 = BODY_KEYS_V1 + ("repo",)


def repo_root() -> Path | None:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, errors="replace"
        )
    except OSError:
        return None
    if r.returncode != 0:
        return None
    return Path(r.stdout.strip())


def repo_key() -> str:
    root = repo_root()
    if root is None:
        return ""
    out = str(root).replace("\\", "/").rstrip("/")
    return out.lower() if os.name == "nt" else out


def signoff_dir() -> Path:
    override = os.environ.get("SIGNOFF_HOME")
    if override:
        return Path(override)
    root = repo_root()
    return (root / ".signoff") if root is not None else (Path.home() / ".signoff")


def ledger_path() -> Path:
    return signoff_dir() / "audit.log"


def tickets_dir() -> Path:
    return signoff_dir() / "tickets"


def body_for(rec: dict) -> dict:
    keys = BODY_KEYS_V2 if "repo" in rec else BODY_KEYS_V1
    return {k: rec.get(k) for k in keys}


def seed_ledger() -> None:
    target = ledger_path()
    if target.exists() or os.environ.get("SIGNOFF_HOME"):
        return
    legacy = Path.home() / ".signoff" / "audit.log"
    if legacy.resolve() == target.resolve() or not legacy.exists():
        return
    lines = [line.strip() for line in legacy.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            return
        rb = rec.get("rollback") or ""
        if not rb or rb == "no-git":
            continue
        if " " in rb:
            return
        try:
            r = subprocess.run(
                ["git", "rev-parse", "--verify", "--quiet", rb], capture_output=True, text=True, errors="replace"
            )
        except OSError:
            continue
        if r.returncode != 0:
            return
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="") as fh:
        fh.write(os.linesep.join(lines) + os.linesep)


def entries() -> list[dict]:
    seed_ledger()
    log = ledger_path()
    if not log.exists():
        return []
    out = []
    for line in log.read_text(encoding="utf-8").splitlines():
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
    tickets_dir().mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(4)
    (tickets_dir() / f"{token}.json").write_text(
        json.dumps({"token": token, "action": action, "target": target, "expires": time.time() + ttl}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"ticket {token}  action={action}  target={target}  ttl={ttl}s")
    print(f'confirm with: signoff p4 confirm --ticket {token} --decision allow --detail "..."')
    return 0


def confirm(ticket: str, decision: str, detail: str, rollback: str) -> int:
    path = tickets_dir() / f"{ticket}.json"
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
        "repo": repo_key(),
    }
    record = dict(body, prev=prev, hash=digest(prev, body))
    ledger_path().parent.mkdir(parents=True, exist_ok=True)
    with ledger_path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    print(json.dumps({"ok": decision == "allow", "hash": record["hash"], "rollback": rollback}, ensure_ascii=False))
    return 0 if decision == "allow" else 1


def verify() -> int:
    chain = entries()
    current = repo_key()
    problems: list[str] = []
    prev = "genesis"
    for i, rec in enumerate(chain, 1):
        body = body_for(rec)
        if rec.get("prev") != prev:
            problems.append(f"line {i}: prev hash mismatch")
        if rec.get("hash") != digest(prev, body):
            problems.append(f"line {i}: content hash mismatch (edited after the fact)")
        prev = rec.get("hash", "")
        owner = rec.get("repo") or ""
        if owner and current and owner != current:
            continue
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

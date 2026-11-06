# Gates — SignOff

> 中文: [gates.md](gates.md)

One command per gate. Each writes `.signoff/pN.json`; exit 0 passes, 1 fails, 2 is a usage or precondition problem.

## P1 `gates/p1_verify.py`

| flag | meaning |
| --- | --- |
| `--run CMD` (repeatable) | command to run; when omitted, `signoff guard` supplies the detected runner |
| `--budget SEC` | budget for all commands together, default 180 s |
| `--install-hook` | write `.git/hooks/pre-commit` containing `exec signoff p1` |
| `--json` / `--quiet` | machine-readable output / errors only |

Output: `{"gate":"p1","ok":true,"elapsedMs":39,"budgetMs":180000,"cases":3,...}`. The case count is the largest number found in `N passed` / `N tests` / `N checks` / `N assertions`.

## Runner detection (`lib/detect.js`, 3.7.0)

`signoff guard` never guesses silently. It resolves a command in this order and prints where the answer came from:

1. `test_cmd` in `.signoff/config.json` (set with `--test-cmd`);
2. `package.json` → `scripts.test`, unless it says `no test specified`;
3. `package.json` dependencies → `vitest` / `jest` / `mocha` (`npx --no-install …`);
4. `Cargo.toml` → `cargo test --quiet`;
5. `go.mod` → `go test ./...`;
6. `Makefile` with a `test:` target → `make test`;
7. python tests (`tests/test_*.py` or `test_*.py` anywhere) → `python -m pytest -q`, else `python -m unittest discover -q`, else a hint that no interpreter exists.

An empty `tests/` directory is not a suite. When tests exist but nothing can run them, `init` / `status` / `doctor` say so instead of reporting a silent skip.

## P2 `gates/p2_coverage.py`

Scans the root plus `packages/` and `apps/` for directories with a `package.json` or `verify/`. Levels:

- `scenario`: `verify/scenarios/*.json` all parse and at least one has a `checks` array;
- `harness`: only pages under `verify/`;
- `smoke`: only a `package.json`;
- `missing`: none of the above.

| flag | meaning |
| --- | --- |
| `--strict` | fail unless every directory reaches `scenario` |
| `--min-scenario N` / `--min-assertions N` | thresholds |
| `--md FILE` | write a Markdown coverage table |

## P3 `gates/p3_queue.py`

Cards live in `tasks/<id>/card.json` by default:

```json
{"id":"t1","goal":"fix the menu","scope":["client.js"],"acceptance":["menu 11/11"],"rollback":"v0.9.34"}
```

| subcommand | behaviour |
| --- | --- |
| `validate` | five fields present, ids unique, scope is an array of strings |
| `plan` | cards whose scopes overlap go into different waves; prints the wave list |
| `collect --changed FILES` | every changed file must be claimed by a card; also lists cards that claimed work but shipped nothing |

## P4 `gates/p4_ledger.py`

Actions are limited to `config` / `profile` / `publish`. The ledger is scoped per repository: `.signoff/audit.log` inside a repo (falling back to `~/.signoff/audit.log` outside one; `SIGNOFF_HOME` forces a directory). Each record carries a `repo` field, and `verify` only checks rollback points for the current repo.

| subcommand | behaviour |
| --- | --- |
| `ask --action --target [--ttl]` | issue a single-use ticket, 600 s by default |
| `confirm --ticket --decision allow\|deny [--detail] [--rollback]` | consume the ticket and append a hash-chained entry; `deny` is recorded too and exits 1 |
| `verify` | recompute the chain (`prev` + content hash) and check that the rollback point is an existing git ref; free text fails |
| `export --out FILE [--merge OTHER...] [--format {md,json,csv}]` | export the ledger; each `--merge` file is re-verified independently and a broken chain is reported with exit 1 |

An entry looks like `{"ts":...,"action":"publish","target":"x@1.0.0","detail":"...","rollback":"v1.0.0","decision":"allow","prev":"<sha256>","hash":"<sha256>"}`.

## P5 `gates/p5_slop.py`

Six rules: `placeholder` (`TODO`, `TBD`, `FIXME`, `待补`, `待定`), `ai-word` (`赋能`/`闭环`/`抓手`/`颗粒度`/`全链路` …), `absolute-claim` (`100%`/`零缺陷`/`永不`/`绝对`/`完美`/`彻底`/`极致`/`无缝`), `empty-adverbs` (two or more in one line), `claim-without-number` (`已验证`/`已覆盖`/`全部通过`/`全绿` on a line with no number), and missing rollback (P4 only).

Fenced code and table rows starting with `|` are skipped so examples are not flagged. `--allow <rule>` relaxes one rule.

## Auto-guard (2.0.0)

After `signoff init`, `pre-commit` / `pre-push` / CI all call `signoff guard`:

| what is staged | gates that actually run |
| --- | --- |
| docs (README, `docs/`) | P5 |
| a detected test runner | P1 |
| `verify/scenarios/` | P2 `--strict` |
| a ledger (`.signoff/audit.log` or `~/.signoff/audit.log`) | P4 `verify` |

`.signoff/cache.json` is keyed by `git write-tree`, so the same staged tree is judged once. `SIGNOFF_SKIP=1` skips and appends to `.signoff/skips.log`; `git commit --no-verify` is git's own hole and leaves no record, which is why CI is the boundary that cannot be bypassed.

A chained (`--chain`) hook keeps its language: `.py`/`.js`/`.ps1`/`.cmd` suffixes pick the interpreter, and the plain `.local` name still runs first (3.9.0).

Since 3.8.0 one hook run at a time holds `.signoff/lock`; a live holder makes the second run exit 1 with the holder's pid, and a lock from a dead pid or older than 10 minutes is broken.

## Runtime (3.0.0 and later)

All five gates and the guard are Node (`lib/p1..p5.js`, `lib/guard.js`); Node 18+ is the only requirement, with no Python fallback. `gates/*.py` is a parity reference only (`npm run parity`).

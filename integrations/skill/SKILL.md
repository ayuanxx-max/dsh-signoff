---
name: signoff-gates
description: Run the SignOff gates (tests, coverage, queue, ledger, anti-slop) before claiming work is done, and explain or repair a red gate. Use when a repo has .signoff/config.json, when the user says "run the gates"/"落印"/"prove it", or before a commit/push in a repo guarded by signoff.
---

# SignOff gates

`signoff` is a CLI (`npm i -g signoff-cli`). It answers one question: does this change
deserve the word "done"? Exit code is the verdict — `0` pass, `1` a gate failed,
`2` usage/environment error. Never re-explain a failure from the source; run the
command and quote its output.

## The one loop

```bash
signoff run            # P1 tests -> P2 coverage -> P3 queue -> P4 ledger -> P5 anti-slop
```

- Read the failing gate id (`p1`..`p5`) from the output, fix the cause, run again.
- `signoff run --json` gives `{ok, gates:[{id, ok, detail}], ms}` for scripting.
- Do not use `SIGNOFF_SKIP=1` or `git commit --no-verify` to get past a red gate:
  both leave a record (`Signoff-Skip:`, and `audit` reports the missing trailer).
  If the gate itself is wrong, fix the config, not the verdict.

## When the output is not enough

```bash
signoff status                 # installed? which hooks, which config, last run
signoff doctor                 # why is it not doing what you expect (read-only)
signoff doctor --fix           # repair what can be proved (hooks, exec bit, stale marker)
signoff explain <gate>         # what this gate checks and how it decides
signoff audit --since-install  # did the commits that landed actually pass?
signoff p4 export --format md  # the ledger, for a human
```

`audit --since-install` refuses an install point that is not an ancestor of HEAD
(rebase/force-push/fresh clone); the fix is `signoff init --reset-install`.

## Installing into a repo

```bash
signoff init                 # hooks + .github/workflows/signoff.yml + .signoff/config.json
signoff init --chain         # keep an existing hook: it runs first, from <name>.local[.ext]
signoff init --lock-test     # pin the detected test command into test_cmd
signoff init --dry-run       # print every write before doing it
signoff uninstall            # remove hooks and CI; --keep-config or --all for state too
```

Never run `signoff init` twice hoping it helps: it is idempotent, and a second run only
rewrites the hooks and the recorded version.

## Reporting

Report the gate ids and their verdicts, plus the exact command that produced them.
"Tests pass" without the gate output is not a report; `signoff run` exiting 0 is.

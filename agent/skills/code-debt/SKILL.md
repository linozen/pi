---
name: code-debt
description: "Harvest every `shortcut:` comment in the codebase into one debt ledger, so the deliberate simplifications left behind get tracked instead of rotting into 'later means never'. Each row names the ceiling and the upgrade trigger pulled straight from the comment; markers with no trigger are flagged as silent-rot risk. Use when the user says 'code debt', 'shortcut debt', 'what did we defer', 'list the shortcuts', 'debt ledger', or 'code-debt'. One-shot report; changes nothing unless asked to persist it."
argument-hint: "[path]  (defaults to repo root)"
---

# Code Debt

The Minimal-Code Discipline in `AGENTS.md` marks every deliberate simplification with a `shortcut:` comment naming its ceiling and upgrade path. This skill collects them into one ledger so a deferral cannot quietly become permanent.

## Scan

Grep the tree for the marker, skipping vendored and generated code:

```bash
grep -rnE '(#|//|--|/\*) ?shortcut:' "${1:-.}" \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=dist --exclude-dir=build --exclude-dir=vendor
```

Add other comment prefixes if the stack uses them. Each hit is one ledger row. Requiring the `shortcut:` marker keeps prose that merely mentions the convention out of the ledger.

## Output

One row per marker, grouped by file:

`<file>:<line> — <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

The convention is `shortcut: <ceiling>, <upgrade path>`, so pull the ceiling and the trigger straight from the comment text. Want an owner per row? add `git blame -L<line>,<line> <file>`.

Flag the rot risk: any `shortcut:` comment that names no upgrade path or trigger gets a `no-trigger` tag — those are the ones that silently rot.

End with: `<N> markers, <M> with no trigger.`

If none are found: `No shortcut: debt. Clean ledger.`

## Boundaries

Reads and reports only; changes nothing. To persist it, ask first, then write the ledger to a file (e.g. `CODE-DEBT.md`). One-shot.

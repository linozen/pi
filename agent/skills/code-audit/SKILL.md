---
name: code-audit
description: "Review code for over-engineering only — what to delete, simplify, or replace with the standard library or a native platform feature. Two scopes: a diff (default: working tree / staged / branch range / PR) or the entire repository (`repo`). One line per finding, ranked biggest cut first; reports, never applies. Use when the user says 'audit for over-engineering', 'what can I delete', 'find bloat', 'is this over-engineered', 'simplify review', 'audit the codebase', or 'code-audit'. Complements /code-review (correctness, security, dependencies) and /simplify (which applies fixes); this one only hunts complexity and only reports."
argument-hint: "[repo | working | staged | <hash> | A..B | <branch>]"
---

# Code Audit

Hunt unnecessary complexity and report it. The best outcome is the codebase getting shorter. This skill finds what to remove; it does **not** apply changes (use `/simplify` for that) and does **not** look for correctness or security bugs (use `/code-review` for those).

## Input

`$ARGUMENTS` — the scope:

- empty / `working` / `staged` / a commit `<hash>` / an `A..B` range / a PR branch name → audit **that diff** for over-engineering (ponytail-review behavior).
- `repo` → audit the **entire tracked tree** (ponytail-audit behavior). This is the whole-codebase mode `/code-review` does not offer.

If the scope is ambiguous, ask once, then proceed.

## Scope assembly

Diff scopes — assemble the changed surface:

```bash
git diff --staged            # staged
git diff                     # working
git diff <A>..<B>            # range
git log -p --first-parent <base>..<branch>   # branch / PR
```

Repo scope — walk the tracked tree, skipping vendored and generated code:

```bash
git ls-files | grep -vE '(^|/)(node_modules|\.git|dist|build|vendor|\.next|target)/'
```

Read the files; rank by likely cut size before reading everything so the biggest wins surface first.

## Tags

One tag per finding:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library already ships. Name the function.
- `native:` a dependency or block of code doing what the platform/runtime/DB already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, a layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## What to hunt (repo scope)

Dependencies the stdlib or platform already ships, single-implementation interfaces, factories with one product, wrappers that only delegate, files exporting one thing, dead flags and config, and hand-rolled reimplementations of stdlib.

## Output

One line per finding, ranked biggest cut first:

`<tag> <what to cut>. <replacement>. [<file>:L<line>]`

End with the only metric that matters:

- diff scope: `net: -<N> lines possible.`
- repo scope: `net: -<N> lines, -<M> deps possible.`

If there is nothing worth cutting: `Lean already. Ship.` and stop.

## Examples

- `stdlib: 27-line EmailValidator class. "@" check + a confirmation mail is the real validation. [auth.py:L12-38]`
- `native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps. [ui/date.ts:L4]`
- `yagni: AbstractRepository with one implementation. Inline it until a second exists. [repo.py:L88]`
- `delete: retry wrapper around an idempotent local call. Nothing replaces it. [tasks.py:L52-71]`
- `shrink: manual loop builds dict. dict(zip(keys, values)), 1 line. [load.py:L30-44]`

## Boundaries

Complexity only. Correctness bugs, security holes, and performance go to `/code-review`, not here. A single smoke test or `assert`-based self-check is the minimum, never bloat — do not flag it for deletion. Lists findings; applies nothing. One-shot. "stop" / "normal mode" reverts to ordinary verbose review.

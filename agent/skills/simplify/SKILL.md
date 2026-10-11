---
name: simplify
description: "Report-only simplification review for uncommitted changes (default), staged changes, the current feature branch against main/develop (`branch [base]`), a file or directory, the whole repository (`repo`), or a proposed plan (`plan`). Find what to delete, reuse, or defer. Use for 'simplify this plan', 'audit for over-engineering', 'what can I delete', 'find bloat', or 'simplify'. Does not apply changes."
argument-hint: "[plan | repo | working | staged | branch [base] | <path> | <hash> | A..B]"
---

# Simplify

Find the smallest viable approach. Report changes worth making; do **not** edit code or plans. For an applied cleanup, ask explicitly to apply the findings. This is not a correctness or security review.

## Input

`$ARGUMENTS` — the scope:

- empty / `working` → audit all **uncommitted** changes: staged, unstaged, and non-ignored untracked files.
- `staged` → audit only staged changes.
- `branch [base]` → audit the current feature branch/worktree against its merge-base with `base` (`main`, `develop`, or an explicit ref). Include committed changes plus staged, unstaged, and non-ignored untracked files. Without `base`, select it only when unambiguous; ask if both main and develop are plausible.
- `<path>` → audit the current contents of that file or directory as a snapshot, even if it has no diff. Skip generated, vendored, and ignored files.
- `<hash>` / `A..B` → audit that commit or diff range.
- `repo` → audit the **entire tracked tree**.
- `plan` → simplify the proposed plan in the current conversation, or a named plan file. If neither is available, ask for the plan. Review the plan's decisions and required behavior, not just its wording.

If the scope is ambiguous, ask once, then proceed.

## Scope assembly

Diff scopes — inspect the changed surface, reading surrounding code for context:

```bash
git diff HEAD                 # working: staged + unstaged tracked changes
git ls-files --others --exclude-standard  # working/branch: non-ignored untracked files (read separately)
git diff --cached             # staged only
git show <hash>               # one commit
git diff <A>..<B>             # range
git merge-base <base> HEAD    # branch: establish common ancestor first
git diff <merge-base>         # branch: committed + staged + unstaged tracked changes
```

For `branch`, resolve an explicit `base` as written if it exists, otherwise try its `origin/` remote-tracking ref; do not fetch or assume refs are current. If omitted, use the sole plausible main/develop branch name (including remote-tracking equivalents); if both exist or neither exists, ask which ref to use. When both local and remote-tracking variants exist, prefer the remote-tracking variant and state which ref was used. State the chosen base and merge-base in the report. Use the current checkout's `HEAD` and working tree, not another worktree's state. For `working` and `branch`, inspect untracked files separately; `git diff` does not show them. Do not treat a deleted file as readable from the working tree.

For `<path>`, inspect that file or the selected subtree (tracked and non-ignored untracked files) as a snapshot; do not silently turn it into a diff scope. `repo` walks the tracked tree, skipping vendored and generated code:

```bash
git ls-files | grep -vE '(^|/)(node_modules|\.git|dist|build|vendor|\.next|target)/'
```

Read the files; rank by likely cut size before reading everything so the biggest wins surface first.

For `plan`, read the plan and only enough surrounding project context to check whether existing behavior covers its goals. Do not implement it.

## Tags

One tag per finding:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library already ships. Name the function.
- `native:` a dependency or block of code doing what the platform/runtime/DB already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, a layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## What to hunt (plan scope)

Challenge whether each planned feature is needed; favor existing code, standard library, native platform behavior, and fewer moving parts. Call out speculative abstractions, configuration, dependencies, phases, and premature generality. Preserve trust-boundary validation, data-loss handling, security, accessibility, and platform calibration. State the simpler alternative and any meaningful trade-off; do not delete necessary requirements merely to shorten the plan.

## What to hunt (repo scope)

Dependencies the stdlib or platform already ships, single-implementation interfaces, factories with one product, wrappers that only delegate, files exporting one thing, dead flags and config, and hand-rolled reimplementations of stdlib.

## Output

One line per finding, ranked biggest cut first:

`<tag> <what to cut>. <replacement>. [<file>:L<line>]`

For `plan`, give concrete cuts with trade-offs and a short revised plan that preserves the goal. Cite plan locations if available; do not invent file or line references. Do not estimate lines of code for an unimplemented plan.

For code, end with an approximate net reduction when supportable (`-<N> lines`, and `-<M> deps` for repo scope). If there is nothing worth cutting, say `Nothing worth simplifying.` and stop.

## Examples

- `stdlib: 27-line EmailValidator class. "@" check + a confirmation mail is the real validation. [auth.py:L12-38]`
- `native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps. [ui/date.ts:L4]`
- `yagni: AbstractRepository with one implementation. Inline it until a second exists. [repo.py:L88]`
- `delete: retry wrapper around an idempotent local call. Nothing replaces it. [tasks.py:L52-71]`
- `shrink: manual loop builds dict. dict(zip(keys, values)), 1 line. [load.py:L30-44]`

## Boundaries

Complexity only. Do not recommend removing necessary tests or safety checks. Do not inspect secret or runtime files, even if untracked. Lists findings; applies nothing.

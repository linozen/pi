---
description: Lightweight Linear ⇄ Plannotator planning flow
argument-hint: "<LINEAR-ID>"
---
Run the lightweight Linear ⇄ Plannotator planning flow for $1.

Use native Pi behavior and the already-configured Linear MCP / Plannotator integrations.

Conventions:
- Normalize the Linear ID to uppercase, e.g. `ENG-123`.
- Branch names use `feature/<lowercase-id>`, e.g. `feature/eng-123`.
- Workspace task worktrees live under `.worktrees/<lowercase-id>/<repo-relative-path>`.
- Keep canonical repo checkouts at the workspace root clean; implementation edits belong in task worktrees.

## Artifact

Write `.plans/<identifier>.md`:

```md
---
linear: <identifier>
branch: feature/<lowercase-identifier>
worktree: .worktrees/<lowercase-identifier>
---
# <identifier>: <title>

<description>

## Context
<!-- Codebase conventions, patterns, constraints, files that matter, and repos likely touched. -->

## Approach
<!-- Chosen direction and one-line rationale. Note rejected alternatives only when useful. -->

## Plan
<!-- Keep Sync Linear last. -->
- [ ] (implement in .worktrees/<lowercase-identifier>/<repo> on branch feature/<lowercase-identifier>)
- [ ] **Sync Linear** — publish Outcome and checklist back to Linear.

## Outcome
<!-- Filled at sync time. -->
```

## Flow

1. Fetch the Linear issue with `get_issue`.
2. Create the plan skeleton.
3. Explore the codebase before coding and fill `Context`.
4. Fill `Approach` and `Plan`.
5. Submit the plan to Plannotator if available; revise until accepted.
6. Stop before implementation unless explicitly asked to continue. After approval, use `/linear-implement <identifier>` to compact planning context and begin implementation.
7. Before Sync, inspect the Harena merge plan with `hr ws merge <identifier>` in a workspace or `hr wt merge <identifier>` in a single repo; do not apply or cleanup without explicit user approval.
8. During Sync, find the relevant `.plans/*.md` file, fill `Outcome`, post it plus the rendered checklist to Linear, update status by discovered status name, and append `<!--linear-synced-->`.
9. After Sync succeeds, delete the temporary plan file unless the user explicitly asked to preserve it.

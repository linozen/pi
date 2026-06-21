---
description: Lightweight Linear ⇄ Plannotator planning flow without rpiv
argument-hint: "<LINEAR-ID>"
---
Run the lightweight Linear ⇄ Plannotator planning flow for $1.

Use native Pi behavior and the already-configured Linear MCP / Plannotator integrations. Do not use rpiv artifacts, rpiv skills, subagents, or workflow machinery.

## Artifact

Write `plans/<identifier>.md`:

```md
---
linear: <identifier>
---
# <identifier>: <title>

<description>

## Context
<!-- Codebase conventions, patterns, constraints, and files that matter. -->

## Approach
<!-- Chosen direction and one-line rationale. Note rejected alternatives only when useful. -->

## Plan
<!-- Keep Sync Linear last. -->
- [ ] (implement)
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
6. Stop before implementation unless explicitly asked to continue.
7. During Sync, fill `Outcome`, post it plus the rendered checklist to Linear, update status by discovered status name, and append `<!--linear-synced-->`.

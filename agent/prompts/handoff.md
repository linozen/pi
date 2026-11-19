---
description: Draft a reviewable handoff for the current task without sending it
argument-hint: "[scope or recipient]"
---
Draft a standalone Markdown handoff for ${@:-the current task}. Use this conversation and the current workspace; verify the repo, branch, revision, and relevant uncommitted changes when available. Do not read past session logs.

Include only what the next operator or agent needs:

- Goal and acceptance criteria.
- Checkout, branch/revision, and relevant files or symbols, with line references when useful. Name the host, Herdr session, and pane or agent only if relevant and verified.
- Decisions and constraints, work completed, and work still open.
- Verification already run with outcomes, and checks not run.
- The first concrete next action, with any approval or dependency it needs.

Separate verified facts from assumptions. Leave out secrets, raw tool output, and transcripts. Return the brief for review in chat; do not write a file, start or message an agent, or send anything to Herdr.

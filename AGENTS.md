# Pi config repo instructions

This repository tracks the curated, reviewable parts of `~/.pi`.

## Scope

- Treat `agent/` as live Pi configuration. Changes there affect future Pi sessions.
- Keep secrets and runtime state out of git. Do not read or commit `agent/auth.json`, `agent/tavily.env`, `agent/mcp-oauth.json`, session logs, cache files, crash logs, or `node_modules`.
- Prefer deleting local wrappers over adding new ones. Native Pi behavior, installed packages, prompt templates, and nono profiles are preferred over custom TypeScript extensions.
- Pi extensions are privileged code. Keep them small, local, and dependency-light.

## Workflow

- Make small, atomic commits using conventional commit messages.
- Before committing, run `git status --short --ignored` and verify ignored secret/runtime files remain untracked.
- Keep plan hygiene strict: use `.plans/*.md` as temporary working files only. Keep at most one active plan per checkout, keep it aligned with the current task, and delete it before the final cleanup commit unless the user explicitly asks to preserve it. Plannotator tools can always be used to get structured feedback from a human operator, and Plannotator keeps its own snapshots under `~/.plannotator`.
- Do not multiplex competing work in one checkout. If a second unrelated task, branch, or plan starts before the current one is cleaned up, create or switch to a separate `git worktree` for that work.
- If a change affects launchers or nono profiles, document the exact verification command in `README.md` or the relevant plan.
- If a change affects Plannotator, verify `/reload`, `/hotkeys`, and one plan submission path where practical.

## Current architecture

- `agent/settings.json` is the package/model/theme entry point.
- `agent/plannotator.json` customizes Plannotator phase labels.
- `agent/prompts/linear-plannotator.md` is the low-code Linear planning flow.
- `agent/extensions/linear-plannotator.ts` owns the local planning/Linear command surface, including `/linear-pull`, `/linear-implement`, and `/linear-sync`, and should stay intact unless an explicit replacement workflow is approved.
- `agent/extensions/statusline.ts` owns the custom footer and `/chatgpt-limit` command.
- `agent/extensions/aliases.ts` owns `/exit`, `/exti`, `/q`, and `/bye`.
- `agent/extensions/context.ts` owns `/context` and subdirectory `AGENTS.md` / `CLAUDE.md` context injection.
- `agent/extensions/subagents.ts` owns the local inspectable `subagent` tool and `/subagents` commands.
- `agent/extensions/ask-user-question.ts` owns the local inspectable `ask_user_question` tool.
- `agent/extensions/terminal-title.ts` owns terminal title updates.
- `agent/extensions/zed-bell.ts` owns terminal bell notifications for Zed Terminal Threads.
- `agent/extensions/local-mcp-adapter/` owns the local MCP proxy integration.

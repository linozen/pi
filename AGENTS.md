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
- Keep plan hygiene strict: use `.plans/*.md` as temporary Zed review files only. Keep at most one active plan per checkout, keep it aligned with the current task, and delete it before the final cleanup commit unless the user explicitly asks to preserve it.
- Do not multiplex competing work in one checkout. If a second unrelated task, branch, or plan starts before the current one is cleaned up, create or switch to a separate `git worktree` for that work.
- If a change affects launchers or nono profiles, document the exact verification command in `README.md` or the relevant plan.

## Current architecture

- `agent/settings.json` is the package/model/theme entry point.
- The iptas workspace owns its awork skill and `/awork <TASK-ID>` command under `32.00_infra/.pi/`; do not duplicate them in this global config.
- `agent/extensions/statusline.ts` owns the custom footer and `/chatgpt-limit` command.
- `agent/extensions/aliases.ts` owns `/exit`, `/exti`, `/q`, and `/bye`.
- `agent/extensions/context.ts` owns `/context` and subdirectory `AGENTS.md` / `CLAUDE.md` context injection.
- `agent/extensions/subagents/` owns the local inspectable `subagent` tool, `/subagents` commands, the ctrl+shift+j live jobs view, and parent-decided timeout windows (`core.ts` is the tested pure logic).
- `agent/subagents/` contains the fixed-tool read-only `scout`, `review`, and `librarian` profiles.
- `agent/extensions/ask-user-question/` owns the local inspectable `ask_user_question` tool.
- `agent/extensions/terminal-title.ts` owns terminal title updates.
- `agent/extensions/zed-bell.ts` owns terminal bell notifications for Zed Terminal Threads.
- `agent/mcp.json` configures native Pi MCP servers; OAuth credentials live in ignored `agent/mcp-auth.json`.

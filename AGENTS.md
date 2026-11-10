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
- Keep repo-local `.plans/*.md` as temporary review files. Keep at most one active plan per checkout and delete it before final cleanup commits unless the user asks to preserve it.
- Do not multiplex competing work in one checkout. If a second unrelated task, branch, or plan starts before the current one is cleaned up, create or switch to a separate `git worktree` for that work.
- If a change affects launchers or nono profiles, document the exact verification command in `README.md` or the relevant plan.

## Current architecture

- `agent/settings.json` is the package/model/theme entry point.
- `agent/extensions/statusline.ts` owns the custom footer and `/chatgpt-limit` command.
- `agent/extensions/aliases.ts` owns `/exit`, `/exti`, `/q`, and `/bye`.
- `agent/extensions/context.ts` owns `/context` and subdirectory `AGENTS.md` / `CLAUDE.md` context injection.
- `agent/extensions/subagents/` owns the local inspectable `subagent` tool, `/subagents` commands, the ctrl+shift+j live jobs view, and parent-decided timeout windows (`core.ts` is the tested pure logic).
- `agent/subagents/` contains the fixed-tool read-only `scout`, `review`, and `librarian` profiles.
- `agent/extensions/ask-user-question/` owns the local inspectable `ask_user_question` tool.
- `agent/extensions/copy-code/` provides the Pi TUI clipboard shortcut.
- `agent/extensions/zed-links/` links local files for the Pi TUI, not RPC clients.
- `agent/mcp.json` configures workstation-local native Pi MCP servers and is Git-ignored; OAuth credentials live in ignored `agent/mcp-auth.json`.

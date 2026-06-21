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
- If a change affects launchers or nono profiles, document the exact verification command in `README.md` or the relevant plan.
- If a change affects Plannotator, verify `/reload`, `/hotkeys`, and one plan submission path where practical.

## Current architecture

- `agent/settings.json` is the package/model/theme entry point.
- `agent/plannotator.json` customizes Plannotator phase labels.
- `agent/prompts/linear-plannotator.md` is the low-code Linear planning flow.
- `agent/extensions/local-mcp-adapter/` is the main custom integration and should remain the exception, not the pattern.
- `plans/` contains reviewable redesign or implementation plans.

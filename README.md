# Local Pi launchers

Curated, reviewable configuration for `~/.pi/agent` and the matching nono launcher workflow.

## Daily workflow

Use the default OpenAI/ChatGPT subscription launcher for normal work:

```sh
n-pi
```

For awork-backed changes, use the single kickoff command:

```text
/awork KEY-123
```

It waits for Pi to become idle, activates Plannotator planning mode, resolves the exact awork task, and submits a repository-aware plan. After approval, native Plannotator continuation runs implementation and the final awork sync; there is no separate implement or sync command.

For direct skill use, run these as two sequential commands:

```text
/plannotator
/skill:awork-task KEY-123
```

For non-awork work, use native `/plannotator` and ask directly for a reviewed plan. The Plannotator tools can always be used to get structured feedback from a human operator.

Plan markdown files created during this loop are temporary repo-local working files. Use `.plans/*.md` for the current task only, keep at most one active plan per checkout, and keep it aligned with that task. awork plans retain a generated sync ID until the outcome comment and approved status transition have both been verified. Delete plan files only after successful finalization unless a plan is intentionally being preserved. Plannotator keeps review snapshots under `~/.plannotator`.

Use a suitable clean checkout for normal task work. Do not run competing work in the same checkout: create or switch to a separate `git worktree` when another task must proceed concurrently or a multi-repo workspace must keep canonical checkouts clean.

## Retained components

- `agent/settings.json` — Pi package/model/theme entry point.
- `agent/models.json` — non-secret Azure/IPTAS model descriptor for the optional Azure launcher.
- `agent/mcp.json` — local MCP server definitions using environment placeholders for credentials.
- `agent/plannotator.json` — short Plannotator phase labels.
- `agent/skills/awork-task/SKILL.md` — awork task resolution, reviewed planning, implementation, and recoverable finalization workflow.
- `agent/extensions/awork-plannotator.ts` — stateless `/awork <TASK-ID>` kickoff; the installed Plannotator package owns `/plannotator` and approval continuation.
- `agent/extensions/statusline.ts` — custom one-line footer/statusline and `/chatgpt-limit` usage command.
- `agent/extensions/aliases.ts` — `/exit`, `/exti`, `/q`, and `/bye` aliases.
- `agent/extensions/context.ts` — `/context` report and subdirectory `AGENTS.md` / `CLAUDE.md` context injection.
- `agent/extensions/subagents.ts` — local inspectable `subagent` tool, live progress/token/tool-call updates, timeout confirmation, `/subagents` profile listing, `/subagents doctor`, and `/subagents run <profile> <task>`.
- `agent/subagents/` — read-only `scout`, `review`, and `librarian` specialist profiles with fixed tool sets and inherited parent models.
- `agent/extensions/ask-user-question/` — local inspectable `ask_user_question` tool for structured clarifying questions.
- `agent/extensions/terminal-title.ts` — keeps the terminal title aligned with the Pi session and working directory.
- `agent/extensions/zed-bell.ts` — terminal bell notification for Zed Terminal Threads when Pi needs a structured answer or finishes a turn.
- `agent/extensions/local-mcp-adapter/` — local MCP proxy extension.
- `agent/keybindings.json` — small TUI navigation keybindings.
- `agent/themes/zedokai-pi.json` — custom theme.
- `agent/skills/` — local opt-in skills.

## Launchers and credentials

The default launcher is `n-pi`, equivalent to `n-pi-openai`:

- Uses nono profile `pi-base-local`.
- Reads `~/.pi/agent/auth.json` for ChatGPT/OpenAI Codex subscription OAuth.
- Does not inject Azure or Mistral API-key variables.

Optional provider launchers remain escape hatches:

- `n-pi-azure` — profile `pi-azure-local`, injects only `AZURE_IPTAS_KEY`, denies `auth.json`, starts `azure-iptas-chat` / `DeepSeek-V4-Flash`.
- `n-pi-mistral` — profile `pi-mistral-local`, injects only `MISTRAL_API_KEY`, denies `auth.json`, starts Mistral.

Secrets live outside git in OAuth files or 1Password-backed nono `env_credentials`.

## nono profiles

Validate profiles:

```sh
nono profile validate pi-base-local
nono profile validate pi-azure-local
nono profile validate pi-mistral-local
```

Inspect profile inheritance and diffs:

```sh
nono profile show pi-base-local
nono profile diff pi-base-local pi-azure-local
nono profile diff pi-base-local pi-mistral-local
```

Check credential presence without printing secrets:

```sh
nono run --silent --allow-cwd --profile pi-azure-local -- \
  /bin/sh -c 'echo AZURE_IPTAS_KEY=$([ -n "${AZURE_IPTAS_KEY:-}" ] && echo present || echo absent)'

nono run --silent --allow-cwd --profile pi-mistral-local -- \
  /bin/sh -c 'echo MISTRAL_API_KEY=$([ -n "${MISTRAL_API_KEY:-}" ] && echo present || echo absent)'
```

## Verification after config changes

```sh
git status --short --ignored
npm --prefix agent/extensions/local-mcp-adapter test
node --test agent/extensions/ask-user-question/core.test.ts
PI_OFFLINE=1 pi --no-session --list-models >/dev/null
```

In Pi:

```text
/reload
/hotkeys
/plannotator
/awork KEY-123
/skill:awork-task KEY-123
/chatgpt-limit
/context
/subagents
/subagents doctor
/refresh-mcp
```

For awork MCP:

```text
mcp({ "action": "status" })
mcp({ "action": "list", "server": "awork" })
```

# Local Pi launchers

Curated, reviewable configuration for `~/.pi/agent` and the matching nono launcher workflow.

## Daily workflow

Use the default OpenAI/ChatGPT subscription launcher for normal work:

```sh
n-pi
```

For awork-backed changes in the iptas workspace, use the single kickoff command:

```text
/awork KEY-123
```

The repository-local command waits for Pi to become idle and starts the awork skill. The skill resolves the exact task, writes `.plans/KEY-123.md`, and prints that path for review in Zed. Reply `approved` to continue implementation and final awork sync in the same conversation; there is no separate implement or sync command.

For direct skill use:

```text
/skill:awork-task KEY-123
```

Plan markdown files are temporary repo-local Zed review files. Use `.plans/*.md` for the current task only, keep at most one active plan per checkout, and keep it aligned with that task. awork plans retain a generated sync ID until the outcome comment and approved status transition have both been verified. Delete plan files only after successful finalization unless a plan is intentionally being preserved.

Use a suitable clean checkout for normal task work. Do not run competing work in the same checkout: create or switch to a separate `git worktree` when another task must proceed concurrently.

## Retained components

- `agent/settings.json` — Pi package/model/theme entry point.
- `agent/mistral/models.json` and `agent/openrouter/models.json` — non-secret provider endpoint descriptors for the optional launchers.
- `agent/mcp.json` — native Pi MCP server definitions using environment placeholders for credentials.
- `agent/extensions/statusline.ts` — custom one-line footer/statusline and `/chatgpt-limit` usage command.
- `agent/extensions/aliases.ts` — `/exit`, `/exti`, `/q`, and `/bye` aliases.
- `agent/extensions/context.ts` — `/context` report and subdirectory `AGENTS.md` / `CLAUDE.md` context injection.
- `agent/extensions/subagents/` — local inspectable background `subagent` jobs with `subagent_result` collection/extension/cancellation, Ctrl+O-aware compact rendering, compact ephemeral child runs, bounded parallel execution, latency metrics, failure reasons, parent-decided timeout windows (expiry notifies the parent instead of killing; hard ceiling `max(1800s, 3x window)`), a ctrl+shift+j live jobs view (`/subagents view`), `/subagents` profile/job listing, `/subagents doctor`, and blocking `/subagents run <profile> <task>`. `core.ts` holds the tested pure logic.
- `agent/subagents/` — read-only `scout`, `review`, and `librarian` specialist profiles with fixed tool sets and inherited parent models.
- `agent/extensions/ask-user-question/` — local inspectable `ask_user_question` tool for structured clarifying questions.
- `agent/extensions/terminal-title.ts` — keeps the terminal title aligned with the Pi session and working directory.
- `agent/extensions/zed-bell.ts` — terminal bell notification for Zed Terminal Threads when Pi needs a structured answer or finishes a turn.
- `agent/keybindings.json` — small TUI navigation keybindings.
- `agent/themes/zedokai-pi.json` — custom theme.
- `agent/skills/` — local opt-in skills.

## Launchers and credentials

The default launcher is `n-pi`, equivalent to `n-pi-openai`:

- Uses nono profile `pi-base-local`.
- Reads `~/.pi/agent/auth.json` for ChatGPT/OpenAI Codex subscription OAuth.
- Does not inject Azure or Mistral API-key variables.
- All launchers set `NONO_LOG_FILE` to `~/.local/state/nono/logs/pi-<provider>-<yyyymmdd>.log`
  (defined in the linozen workspace at `31.00_infra/mbp/home.nix`, `programs.zsh.initExtra`; apply with
  `31.00_infra/mbp/bootstrap.sh switch`, which builds the same nix-darwin flake). nono's proxy keeps only the first 4096 network
  audit events per session and then warns once per dropped event on stderr; those WARN lines corrupt
  TUI display in herdr threads. `NONO_LOG_FILE` routes nono/proxy tracing logs to the file instead of
  the terminal while keeping banners, summaries, and diagnostics footers on the terminal. The audit
  trail stays enabled; `--no-audit` would remove the warnings too but disables the per-session audit
  trail. Verify after relaunching:

```sh
ls -la ~/.local/state/nono/logs/
grep -c "Network audit buffer full" ~/.local/state/nono/logs/pi-*.log
```

Optional provider launchers remain escape hatches:

- `n-pi-azure` — profile `pi-azure-local`, injects only `AZURE_IPTAS_KEY`, denies `auth.json`, starts `azure-iptas-chat` / `DeepSeek-V4-Flash`.
- `n-pi-mistral` — profile `pi-mistral-local`, injects only `MISTRAL_API_KEY`, denies `auth.json`, starts Mistral.

Secrets live outside git in OAuth files or 1Password-backed nono `env_credentials`.

## Security assessments

Use the private Strix runner on Fly.io. Setup, secrets, scope, and lifecycle
instructions are in
`/Users/lino/Documents/30-39_Code/31_linozen.com/31.01_sites/strix/README.md`.

After changing the Aperture launcher, validate its Nix source with
`nix-instantiate --parse mbp/home.nix >/dev/null` from the infrastructure
checkout. Apply the reviewed configuration separately with `nix-config-switch`;
that switch also applies other pending configuration changes.

## smolvm VM lane (`n-vibe`)

`n-vibe` runs the Mistral Vibe CLI inside an ephemeral smolvm microVM with the current
directory mounted at `/workspace`. It works both from a plain terminal and from inside
nono-sandboxed Pi sessions; the same rules apply to any agent-driven `smolvm` call:

- **Keep the normal HOME.** smolvm stores machine state under
  `~/Library/Application Support/smolvm/` and caches under `~/Library/Caches/smolvm/`.
  The current Pi/nono profile permits those paths; an offline ephemeral VM booted with
  the normal HOME in-sandbox. The earlier DEV-134 workaround of redirecting HOME to
  `~/.cache/smolvm-home` is no longer needed. A different HOME means a different
  machine list and image cache; don't redirect it for routine runs.
- **Unset proxy variables** (`env -u HTTP_PROXY ...`) before invoking smolvm. nono's audit
  proxy binds host loopback only; smolvm refuses to pass a loopback proxy into a machine
  (guest loopback is not host loopback) and aborts at config validation otherwise.
- **The session's nono invocation must carry an IPC port allowance** (`--open-port`). Under
  nono's default proxy-only macOS seatbelt template, `machine start`/`machine run` die at
  `krun_start_enter` with `-22 (EINVAL)` (libkrun rejects the VM device setup); any
  `--open-port` flips seatbelt generation into the proxy+IPC template, under which VMs boot.
  All three launchers carry this: `n-pi-openai` → `--open-port 17776`, `n-pi-mistral` →
  `--open-port 17777`, `n-pi-openrouter` → `--open-port 17778`. The port is a seatbelt
  allowance only — nothing binds it, and the audit proxy keeps a random per-session
  port, so concurrent same-launcher sessions do not collide.
  Bisected empirically (DEV-134): no flags FAIL, `--proxy-port` alone FAIL, `--open-port`
  alone PASS, profile choice irrelevant.
- **Guest egress is not nono-audited.** Direct TCP from sandboxed processes is allowed (nono's
  network enforcement is proxy-cooperative), so VM traffic bypasses the audit proxy. Use
  smolvm's `--allow-host-pattern` (DNS-level, CDN-safe) as the compensating egress filter;
  `n-vibe` restricts the guest to `api.mistral.ai`, `pypi.org`, and `files.pythonhosted.org`.
- Verified in-sandbox: offline ephemeral VM with the normal HOME and proxies unset.
  Earlier persistent lifecycle tests used a redirected HOME.

If fully audited VM egress is ever required, the nono-side option is binding the audit proxy
on a non-loopback interface so smolvm's `--use-host-proxy` rewrite can reach it — a
boundary decision for the nono owner, not a Pi-session change.

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
pi mcp list
node --test agent/extensions/ask-user-question/core.test.ts
node --test agent/extensions/subagents/core.test.ts
PI_OFFLINE=1 pi --no-session --list-models >/dev/null
```

In Pi from the iptas workspace:

```text
/reload
/awork KEY-123
/skill:awork-task KEY-123
/chatgpt-limit
/context
/subagents
/subagents doctor
/subagents view (or ctrl+shift+j)
/mcp
```

Native MCP reads `agent/mcp.json` globally and trusted project `.pi/mcp.json` files. It does not read `.mcp.json`. Use `/mcp` to inspect servers and `/mcp login <server>` to authorize any OAuth servers. Native credentials are stored in ignored `agent/mcp-auth.json`; old adapter credentials do not transfer. After editing MCP config, run `/reload` or restart Pi, then `pi mcp list` to check connectivity. Local servers must be running to connect.

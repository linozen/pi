# Pi configuration

Curated Pi configuration for this workstation and portable agent hosts. Paseo
is the primary interface; the Pi terminal UI remains available as a fallback.
This repository does not include credentials, session history, or local MCP
server configuration. Its agent-side instructions are in `agent/AGENTS.md`.

## Starting Pi

The Mac launchers are defined in the infra checkout at `31.00_infra/mbp/home.nix`:

- `n-pi` / `n-pi-openai`: OpenAI Codex subscription through nono; also usable
  as the terminal fallback. Paseo uses the same sandboxed launcher in RPC mode.
- `n-pi-ap`: legacy workstation-local Aperture launcher, pending migration to
  the project that uses it. Its ignored provider home is not in a fresh clone.

Changes to the Mac launchers require a separately reviewed Nix activation;
that activation can apply unrelated pending changes. The guest fleet has its
own provisioning and is not updated by committing this repository.

## Components

- `agent/settings.json` — package, model and TUI theme settings.
- `agent/extensions/context.ts` — `/context` and subdirectory context loading.
- `agent/extensions/subagents/` and `agent/subagents/` — bounded local
  background subagents and read-only profiles. `/subagents view` and its
  `ctrl+shift+j` shortcut require the Pi TUI; the tools work independently of
  that view. Paseo's own agent tools depend on daemon access and configuration.
- `agent/extensions/ask-user-question/` — structured questions.
- `agent/extensions/zed-links/` — local Zed file links in the Pi TUI only.
- `agent/extensions/copy-code/` — Pi TUI clipboard shortcut.
- `agent/extensions/statusline.ts` — Pi TUI footer and `/chatgpt-limit`.
- `agent/extensions/aliases.ts` — quit command aliases.
- `agent/skills/` and `agent/prompts/` — opt-in skills and prompt templates.
  The Anki skill requires `dt`; librarian web research requires web tools.
- `agent/keybindings.json` and `agent/themes/` — Pi TUI presentation.

## Host-local resources

Aperture models and provider settings, `agent/models.json`, Pi-managed
`agent/bin/` search binaries, and native MCP settings are not tracked. Install
`rg` and `fd` for the host or let Pi provision its platform-specific binaries.
For nono, install its Pi package on the host and link its extension and skill
locally; this Mac uses ignored symlinks at `agent/extensions/nono-sandbox.ts`
and `agent/skills/nono-sandbox`. The nono installer may write a host-specific
package path to `agent/settings.json`; keep that path out of commits.

## Local MCP configuration

Pi reads user-level servers from `agent/mcp.json` and, in trusted projects,
project servers from `.pi/mcp.json`. The user-level file is Git-ignored and
must be configured separately on each host, for example with `pi mcp add`.
The Aperture launcher disables MCP. Credentials and OAuth tokens remain outside
Git. Use `/mcp` to inspect session status and sign in; after editing the file,
run `/reload` or restart Pi. `pi mcp list` checks configured connections, which
requires their services to be available. Pi does not read `.mcp.json`.

## Verification

Before committing, inspect `git status --short --ignored` and ensure runtime
files and credentials remain untracked. Run the local extension tests:

```sh
node --test agent/extensions/{ask-user-question,subagents,copy-code,zed-links}/core.test.ts
```

For changes to native MCP configuration, use `/mcp` or `pi mcp list`. For
changes to the Mac launchers, validate the Nix source from the infra checkout:

```sh
nix-instantiate --parse mbp/home.nix >/dev/null
```

That syntax check does not activate the configuration or test a live Paseo
session. Verify affected UI interactions in Paseo and, where applicable, the
Pi TUI after `/reload` or restart.

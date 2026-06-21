# Local Pi launchers

Curated, reviewable configuration for `~/.pi/agent` and the matching nono launcher workflow.

## Daily workflow

Use the default OpenAI/ChatGPT subscription launcher for normal work:

```sh
n-pi
```

For non-trivial changes, use Plannotator as the planning gate:

```text
/plannotator
```

or the local shortcut/alias surface:

```text
/plan
Ctrl+Super+P
```

For Linear-backed work, use the local command wrapper:

```text
/linear-pull ENG-123
```

After implementation, sync the outcome back to Linear:

```text
/linear-sync ENG-123
```

For non-Linear work, skip Linear and ask directly for a Plannotator-reviewed plan. The Plannotator tools can always be used to get structured feedback from a human operator.

Plan markdown files created during this loop are temporary repo-local working files. Iterate on them for Plannotator review, then delete them before the final cleanup commit unless a plan is intentionally being preserved. Plannotator keeps review snapshots under `~/.plannotator`.

## Retained components

- `agent/settings.json` — Pi package/model/theme entry point.
- `agent/models.json` — non-secret Azure/IPTAS model descriptor for the optional Azure launcher.
- `agent/plannotator.json` — short Plannotator phase labels.
- `agent/prompts/linear-plannotator.md` — prompt-template fallback for Linear issue planning.
- `agent/extensions/linear-plannotator.ts` — command surface for `/plan`, `/plannotator`, `/plan-status`, `/linear-pull`, `/linear-sync`, and `Ctrl+Super+P`.
- `agent/extensions/statusline.ts` — custom one-line footer/statusline and ChatGPT usage command.
- `agent/extensions/exit-alias.ts` — `/exit` alias.
- `agent/extensions/local-mcp-adapter/` — local MCP proxy extension.
- `agent/keybindings.json` — small TUI navigation keybindings.
- `agent/themes/zedokai-pi.json` — custom theme.
- `agent/skills/` — local opt-in skills.

Cleanup should keep this command surface intact unless the replacement workflow is explicitly approved.

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
```

In Pi:

```text
/reload
/hotkeys
/plan-status
/plannotator
```

For Linear and MCP:

```text
/linear-pull ENG-123
mcp({ "action": "status" })
mcp({ "action": "search", "query": "linear" })
```

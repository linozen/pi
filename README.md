# Local Pi launchers

This setup separates provider credentials by launcher. The default `n-pi` path is the ChatGPT/OpenAI subscription path. The Pi customization is intentionally native and small: local extensions under `~/.pi/agent/extensions/`, prompt templates under `~/.pi/agent/prompts/`, and only the Plannotator package plus the nono package in `settings.json`.

## Launchers

### `n-pi-openai`

Uses profile `pi-base-local` and starts Pi normally:

```sh
n-pi-openai
```

Credential behavior:

- Reads `~/.pi/agent/auth.json` for ChatGPT/OpenAI Codex subscription OAuth.
- Does not inject provider API-key environment variables.
- `n-pi` is an alias for this launcher.

### `n-pi-azure`

Uses profile `pi-azure-local` and injects only the Azure/IPTAS key from 1Password:

```sh
n-pi-azure
```

Credential behavior:

- Injects `AZURE_IPTAS_KEY` from `op://Private/iptas-local-dev/codex-azure-api-key` via nono `env_credentials`.
- Does not read `~/.pi/agent/auth.json`.
- Does not inject Mistral or OpenAI API-key variables.
- Starts Pi with `--provider azure-iptas-chat --model DeepSeek-V4-Flash --api-key "$AZURE_IPTAS_KEY"`.

The non-secret Azure model descriptor lives in `~/.pi/agent/models.json`. The actual key is not stored there.

### `n-pi-mistral`

Uses profile `pi-mistral-local` and injects only the Mistral key from 1Password:

```sh
n-pi-mistral
```

Credential behavior:

- Injects `MISTRAL_API_KEY` from `op://Private/Mistral/API Key` via nono `env_credentials`.
- Does not read `~/.pi/agent/auth.json`.
- Does not inject Azure or OpenAI API-key variables.
- Starts Pi with `--provider mistral --model mistral-large-latest --api-key "$MISTRAL_API_KEY"`.

## Profile structure

`pi-base-local` contains the shared sandbox policy. Provider profiles are intentionally small and inherit from it:

- `pi-base-local`: no extra credentials; allows `~/.pi/agent/auth.json` for subscription OAuth and is used directly by `n-pi-openai`.
- `pi-azure-local`: injects only `AZURE_IPTAS_KEY` and denies `~/.pi/agent/auth.json`.
- `pi-mistral-local`: injects only `MISTRAL_API_KEY` and denies `~/.pi/agent/auth.json`.

Shared policy in `pi-base-local`:

- Uses `environment.allow_vars` to pass only basic shell/UI/terminal variables; injected credentials bypass this allow-list by nono design.
- Blocks common container control sockets with `filesystem.deny` instead of raw macOS Seatbelt rules.
- Keeps network direct; no nono reverse proxy credential injection is used.

Terminal/color handling:

- Pi is installed via Homebrew as a Node script (`/opt/homebrew/bin/pi`).
- The previous mise standalone Bun binary dropped most of `process.env` inside nono on macOS, causing Pi to fall back from truecolor to saturated 256-color tool backgrounds.
- With the Homebrew/Node install, terminal variables such as `TERM`, `COLORTERM`, and `TERMINFO` are visible to Pi directly, so no terminal-env extension or wrapper flags are needed.

## Files

Shell functions:

- `~/.zshrc`

nono profiles:

- `~/.config/nono/profiles/pi-base-local.json`
- `~/.config/nono/profiles/pi-azure-local.json`
- `~/.config/nono/profiles/pi-mistral-local.json`

Pi config:

- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`
- `~/.pi/agent/extensions/linear-plannotator.ts` — `/linear-pull` and `/linear-sync`
- `~/.pi/agent/prompts/linear-plannotator.md` — manual `/linear-plannotator <LINEAR-ID>` prompt template
- `~/.pi/agent/extensions/chatgpt-limit.ts` — local ChatGPT usage footer
- `~/.pi/agent/extensions/exit-alias.ts` — `/exit` alias

## Maintenance notes

Run this after editing the shell functions:

```sh
source ~/.zshrc
```

Validate profiles with:

```sh
nono profile validate pi-base-local
nono profile validate pi-azure-local
nono profile validate pi-mistral-local
```

Inspect profile inheritance and diffs with:

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

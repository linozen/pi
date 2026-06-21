# Pi agent instructions

## Communication

- Use functional, direct technical prose.
- Do not use simulated empathy, rapport-building, validation prompts, or enthusiasm markers.
- Ask clarifying questions only when required to proceed.

## Safety

- Do not read or print secrets unless the user explicitly names the file and requests it.
- Treat these as secret/runtime files: `auth.json`, `tavily.env`, `mcp-oauth.json`, `.env*`, session logs, crash logs, caches, and credential files.
- If a command requires 1Password secrets, write an operator-run script instead of printing or revealing secrets in the session.
- Treat Pi extensions as privileged code. Minimize dependencies and keep custom extensions reviewable.
- Docker access is read-only through `http://dro.localhost:7080`; do not use Docker CLI/socket/Compose unless the user explicitly changes this constraint.

## nono sandbox

If file, command, or network access fails with `Operation not permitted`, `Permission denied`, `EACCES`, `EPERM`, `landlock`, or sandbox-denied errors, diagnose with:

```sh
nono why --self --path <blocked-path> --op <read|write|readwrite>
```

Then present exactly two remediation options:

- Option A: restart with a one-off grant, e.g. `nono run --profile pi --allow /path/to/needed -- pi`
- Option B: draft a persistent profile under `~/.config/nono/profile-drafts/<name>.json`, ask the user to run `nono profile promote <name>`, then start future sessions with that profile.

Do not suggest `sudo`, `chmod`, `chown`, Full Disk Access, or Pi approval changes for nono denials.

## Engineering defaults

- Prefer deletion and native behavior over new wrappers.
- Before adding dependencies, check whether the standard library, platform, or existing lockfile already covers the need.
- Do not introduce abstractions with only one implementation.
- Make small conventional commits when asked to commit.
- Treat repo-local plan markdown files as temporary Plannotator working files. Iterate on them during planning, then delete them before final cleanup commits unless the user asks to keep them. Plannotator tools can always be used to get structured feedback from a human operator, and Plannotator snapshots plan history under `~/.plannotator`.
- Leave one runnable verification for non-trivial logic.

## This `~/.pi` config

- This repo tracks curated Pi config, not runtime state.
- Keep `agent/auth.json`, `agent/tavily.env`, `agent/mcp-oauth.json`, `agent/sessions/`, caches, crash logs, and `node_modules` out of git.
- `agent/settings.json` is the main package/model/theme entry point.
- `agent/plannotator.json` customizes Plannotator phase labels.
- `agent/prompts/linear-plannotator.md` is the low-code Linear planning flow.
- `agent/extensions/local-mcp-adapter/` is the main custom integration and should remain the exception.
- For Plannotator changes, verify `/reload`, `/hotkeys`, and one plan submission path where practical.

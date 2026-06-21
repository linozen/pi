# Pi setup/workflow simplification plan

## Context
- The current documented workflow has three provider-specific launchers (`n-pi-openai`, `n-pi-azure`, `n-pi-mistral`) backed by three nono profiles.
- The local agent directory contains several convenience layers: local extensions (`chatgpt-limit.ts`, `linear-plannotator.ts`, `exit-alias.ts`, `local-mcp-adapter`), prompt templates, custom skills, a custom theme, keybindings, model descriptors, generated session/cache files, and npm/package artifacts.
- Complexity hotspots found so far:
  - Provider workflow is split across shell launchers, nono profiles, `agent/models.json`, OAuth auth files, and README instructions.
  - `agent/extensions/chatgpt-limit.ts` is a 359-line custom footer/usage implementation that duplicates UI/status concerns and can become a maintenance burden.
  - `agent/extensions/linear-plannotator.ts` is a 201-line wrapper that duplicates the `agent/prompts/linear-plannotator.md` flow and also wraps Plannotator plan-mode toggling/status.
  - `agent/extensions/local-mcp-adapter/index.ts` is an 837-line local MCP implementation plus a checked-in `node_modules` tree (~24 MB). It is valuable if Pi lacks native MCP support, but it is the largest bespoke component.
  - `agent/npm/` is large (~261 MB) and appears to only declare npm packages already listed directly in `agent/settings.json`.
  - Generated/runtime files (`sessions`, `mcp-metadata-cache.json`, `pi-crash.log`, OAuth/auth/env files) are mixed with curated config in `agent/`.
- User preference: opinionated redesign with complexity reduction, not a conservative cleanup.

## Approach
- Make the daily path boring: one default `pi` launcher/profile for normal work, with optional explicit provider commands only for real exceptions.
- Cut custom code first. Prefer native Pi/Plannotator/package behavior and prompt templates over local TypeScript wrappers.
- Keep credential safety, but reduce the number of visible choices. The redesigned default should use the subscription/OpenAI path; Azure/Mistral become optional escape hatches or are removed if unused.
- Split curated config from runtime/cache/secrets in documentation and ignore rules, so the repo represents intentional setup rather than Pi’s whole state directory.
- Treat the local MCP adapter as the main decision point: either replace it with native/package MCP support if available, or keep it as the only sanctioned custom extension and remove surrounding convenience wrappers.

## Files to modify
- `README.md`
- `agent/settings.json`
- `agent/extensions/chatgpt-limit.ts` — likely remove
- `agent/extensions/linear-plannotator.ts` — likely remove or shrink to only Linear helpers if still needed
- `agent/extensions/exit-alias.ts` — likely keep only if `/exit` is important; otherwise remove
- `agent/prompts/linear-plannotator.md` — keep as the lightweight Linear planning entry point if the TS wrapper is removed
- `agent/extensions/local-mcp-adapter/` — either retain as the one complex local extension or replace/remove if native MCP can cover it
- `agent/npm/` — likely remove if not required by Pi package loading
- `.gitignore` or equivalent ignore rules if absent/insufficient
- External live config to update outside this repo, if approved: `~/.zshrc` launchers and `~/.config/nono/profiles/pi-*.json`

## Reuse
- Existing `pi-base-local` profile as the single default profile; it already extends `always-further/pi`, injects `TAVILY_API_KEY`, and contains the shared sandbox policy.
- Existing Azure and Mistral child profile pattern if provider escape hatches remain.
- Existing `agent/prompts/linear-plannotator.md` as the low-code replacement for duplicated Linear/Plannotator TypeScript command logic.
- Existing Plannotator package in `agent/settings.json` for plan mode instead of local status/toggle wrappers.
- Existing Tavily package in `agent/settings.json`; no need for a separate `agent/npm/` dependency project if Pi installs from settings.
- Existing README non-secret profile validation and credential-presence checks.

## Steps
- [ ] Decide whether Azure and Mistral are still real daily workflows; if not, remove them from the default mental model and docs.
- [ ] Rename/standardize the primary launcher to `pi` or `n-pi`, backed by one default profile (`pi-base-local` or renamed `pi-local`).
- [ ] Move Azure/Mistral to optional explicit commands (`pi-azure`, `pi-mistral`) or archive their profiles entirely.
- [ ] Remove `chatgpt-limit.ts` and rely on native Pi footer/context/cost UI unless a specific missing signal is essential.
- [ ] Remove `linear-plannotator.ts` plan-mode/status/hotkey wrapper and rely on Plannotator’s built-in command/shortcut plus `agent/prompts/linear-plannotator.md` for the Linear flow.
- [ ] Keep or remove `exit-alias.ts` based on whether `/exit` is worth a local extension file; default recommendation is remove unless muscle memory is strong.
- [ ] Evaluate MCP: replace `local-mcp-adapter` with native/package MCP support if available; otherwise keep it as the single custom extension and document it as the exception.
- [ ] Remove stale/generated/heavy artifacts from curated config tracking: `agent/npm/`, checked-in `node_modules`, sessions, crash logs, metadata caches, and secret-bearing runtime files.
- [ ] Update `README.md` to document the new daily workflow first, and move provider/MCP/debug details to a short “escape hatches” section.
- [ ] Add concise verification commands for the retained profile(s), retained launcher(s), Pi startup, Plannotator plan mode, Linear/MCP access, and credential presence without printing secrets.

## Verification
- Validate the retained nono profile(s): `nono profile validate ...`.
- Start the default launcher from a normal project directory and confirm Pi reaches the prompt without provider-choice warnings.
- If optional provider launchers remain, start each once and verify credential presence via non-secret shell tests.
- In Pi, verify package/extension loading with `/reload` and `/hotkeys` only for retained local extensions.
- Verify Plannotator plan mode via its native command/shortcut and one plan submission.
- Verify Linear workflow through the retained prompt or MCP path by fetching one issue without exposing tokens.
- Confirm `README.md` describes exactly the retained workflow and no removed command.

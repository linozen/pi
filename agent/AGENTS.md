# Pi agent instructions

## Communication

- Use functional, direct technical prose.
- Do not use simulated empathy, rapport-building, validation prompts, praise, or enthusiasm markers.
- Do not reassure, flatter, or validate ideas by default. Treat claims and plans as hypotheses to test.
- Disagree explicitly when the user is likely wrong, the plan is brittle, unsafe, overcomplicated, or not worth doing. State the reason and the better alternative.
- Lead with the strongest material objection before implementation when a request has a likely flaw. Do not bury disagreement in caveats.
- Say `no` when the correct answer is no; do not soften it into preference language or offer unnecessary compromises.
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

- Before writing code, stop at the first rung that holds: does this need to exist; does this codebase already have it; does the standard library do it; does the native platform do it; does an installed dependency do it; can this be one line; only then write the minimum code that works.
- Prefer deletion and native behavior over new wrappers. Keep changes to the fewest files possible.
- Do not add boilerplate, options, configuration, abstractions, or dependencies unless the task requires them.
- Before adding dependencies, check whether the standard library, platform, or existing lockfile already covers the need.
- Do not introduce abstractions with only one implementation.
- Question complex or over-broad requests before implementation: do they actually need the requested mechanism, or does a smaller existing mechanism cover it?
- Be lazy about the solution, not about understanding: read the code the change touches and trace the real flow before choosing the small path.
- Before editing code in a subdirectory or nested repository, check for the nearest `AGENTS.md` or `CLAUDE.md` from the target file's directory upward to the session cwd, and read/apply it if it was not already loaded. This matters when pi starts at a parent workspace such as `~/src/project` but the edit target is `~/src/project/repo-1` with its own `AGENTS.md`.
- Do not optimize away trust-boundary validation, data-loss error handling, security, accessibility, or hardware/platform calibration.
- Mark intentional simplifications with a `shortcut:` comment naming the ceiling and the upgrade trigger.
- Make small conventional commits when asked to commit.
- Treat repo-local `.plans/*.md` files as temporary Plannotator working files. Keep at most one active plan per checkout, keep it aligned with the current task, and delete it before final cleanup commits unless the user asks to keep it. Plannotator tools can always be used to get structured feedback from a human operator, and Plannotator snapshots plan history under `~/.plannotator`.
- Do not multiplex competing work in one checkout. If a second unrelated task, branch, or plan starts before the current one is cleaned up, create or switch to a separate `git worktree` for that work.
- Linear task branches use `feature/<lowercase-id>` (for example `feature/eng-123`). In multi-repo workspaces, keep canonical repo checkouts clean and put task edits under `.worktrees/<lowercase-id>/<repo-relative-path>`.
- Leave one runnable verification for non-trivial logic.

## This `~/.pi` config

- This repo tracks curated Pi config, not runtime state.
- Keep `agent/auth.json`, `agent/tavily.env`, `agent/mcp-oauth.json`, `agent/sessions/`, caches, crash logs, and `node_modules` out of git.
- `agent/settings.json` is the main package/model/theme entry point.
- `agent/plannotator.json` customizes Plannotator phase labels.
- `agent/prompts/linear-plannotator.md` is the low-code Linear planning flow.
- `agent/extensions/linear-plannotator.ts` owns `/linear-pull`, `/linear-implement`, `/linear-sync`, `/plan`, and `/plan-status`.
- `agent/extensions/local-mcp-adapter/` is the largest custom integration; keep all local extensions reviewable and dependency-light.
- `agent/extensions/context.ts` owns both `/context` reporting and subdirectory context injection.
- `agent/extensions/subagents.ts` owns the local inspectable `subagent` tool and `/subagents` commands.
- `agent/extensions/ask-user-question.ts` owns the local inspectable `ask_user_question` tool.
- `agent/extensions/terminal-title.ts` owns terminal title updates.
- `agent/extensions/zed-bell.ts` owns terminal bell notifications for Zed Terminal Threads.
- For Plannotator changes, verify `/reload`, `/hotkeys`, and one plan submission path where practical.

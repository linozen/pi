# Pi agent instructions

## Communication

- Use functional, direct technical prose.
- When referring to local files for Zed review, always use their full absolute paths, optionally followed by a 1-based `:line` or `:line:column` location.
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
- Agents may use SSH for inspection. On dev, staging, and production hosts, every state-changing command (including Docker, Compose, database, and filesystem mutations) requires explicit operator approval of the exact target and command. Host Docker CLI/socket/Compose mutations still require explicit operator approval. Inside a disposable smolvm guest with its own Docker daemon, guest Docker/Compose and Docker-backed tests need no separate approval; never use the host socket or mount real credentials into the guest.
- In Paseo RPC sessions on macOS, use `script -q /dev/null ssh ...` when SSH needs 1Password approval; the pseudo-terminal allows the approval prompt to appear. Preserve the normal SSH safety rules.
- For smolvm under nono, Pi must have been launched with `--open-port`. Use the normal `HOME` so workflows share the host image cache; unset inherited `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase variants instead of forwarding nono's loopback proxy into the guest. If enabling guest networking, restrict egress with `--allow-host-pattern`.

## nono sandbox

If file, command, or network access fails with `Operation not permitted`, `Permission denied`, `EACCES`, `EPERM`, `landlock`, or sandbox-denied errors, diagnose with:

```sh
nono why --self --path <blocked-path> --op <read|write|readwrite>
```

Treat the denial as an intentional control point, not automatically as a policy defect. After diagnosis:

- First decide whether the agent actually needs ongoing access.
- For a safe, narrowly scoped command that the workflow needs only once, prefer giving the operator the exact command or script to run outside the sandbox, then continue from its result. Do not design or widen a policy solely for a one-off operation.
- Suggest restarting with a one-off grant, such as `nono run --profile pi --allow /path/to/needed -- pi`, only when the agent itself needs continued access during the session.
- Draft a persistent profile under `~/.config/nono/profile-drafts/<name>.json` only for a demonstrated recurring requirement and after the user chooses that approach.

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
- Treat repo-local `.plans/*.md` files as temporary Zed review files. Keep at most one active plan per checkout, keep it aligned with the current task, and delete it before final cleanup commits unless the user asks to keep it.
- Do not multiplex competing work in one checkout. If a second unrelated task, branch, or plan starts before the current one is cleaned up, create or switch to a separate `git worktree` for that work.
- awork task branches use `feature/<lowercase-id>` (for example `feature/key-123`). Reuse a suitable clean checkout by default.
- Leave one runnable verification for non-trivial logic.

## This `~/.pi` config

- This repo tracks curated Pi config, not runtime state.
- Keep `agent/auth.json`, `agent/tavily.env`, `agent/mcp-auth.json`, `agent/mcp-oauth.json`, `agent/sessions/`, caches, crash logs, and `node_modules` out of git.
- `agent/settings.json` is the main package/model/theme entry point.
- The iptas workspace owns its awork skill and `/awork <TASK-ID>` command under `32.00_infra/.pi/`; do not duplicate them in this global config.
- `agent/mcp.json` defines native Pi MCP servers; use `/mcp` for session status and sign-in.
- `agent/extensions/context.ts` owns both `/context` reporting and subdirectory context injection.
- `agent/extensions/subagents/` owns the local inspectable `subagent` tool, `/subagents` commands, the ctrl+shift+j live jobs view, and parent-decided timeout windows (`core.ts` is the tested pure logic).
- `agent/subagents/` contains the fixed-tool read-only `scout`, `review`, and `librarian` profiles.
- `agent/extensions/ask-user-question/` owns the local inspectable `ask_user_question` tool.
- `agent/extensions/terminal-title.ts` owns terminal title updates.
- `agent/extensions/zed-bell.ts` owns terminal bell notifications for Zed Terminal Threads.

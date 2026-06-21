# Fix Plannotator plan-mode shortcut/status indicator

## Context
- User wants only `Ctrl+Cmd+P` (`ctrl+super+p`) to toggle plan mode.
- Current local wrapper in `agent/extensions/linear-plannotator.ts` registers both `ctrl+super+p` and `ctrl+alt+p`, causing a shortcut conflict warning with Plannotator's built-in `Ctrl+Alt+P`.
- Plannotator package already supports footer status via `ctx.ui.setStatus("plannotator", ...)` and reads `agent/plannotator.json` for status labels.
- `agent/plannotator.json` currently defines planning/executing labels, so if the footer is not visible it may be because the toggle path is bypassing the wrapper or the status is being cleared/overwritten after toggling.

## Approach
- Keep the local `linear-plannotator` wrapper as the owner of `ctrl+super+p` only.
- Remove `ctrl+alt+p` from the wrapper so the built-in Plannotator shortcut remains untouched and no conflict warning is emitted.
- Make the wrapper explicitly refresh the Plannotator phase after toggling and set a dedicated status key with a short persistent label, rather than fighting the package's own `plannotator` status slot.
- Use a small deferred refresh after toggle to handle the package's asynchronous status clearing/restoration order.

## Files to modify
- `agent/extensions/linear-plannotator.ts`
- Potentially `agent/plannotator.json` only if label text should be shortened.

## Reuse
- Existing event bridge: `requestPlanMode(...)` in `agent/extensions/linear-plannotator.ts`.
- Existing Plannotator plan-mode event channel: `plannotator:request`.
- Existing status API: `ctx.ui.setStatus(...)`.
- Existing `Key.ctrlSuper("p")` helper from `@earendil-works/pi-tui`.

## Steps
- [x] Remove `Key.ctrlAlt("p")` registration from `agent/extensions/linear-plannotator.ts`.
- [x] Keep only `pi.registerShortcut(Key.ctrlSuper("p"), ...)`.
- [x] Adjust `togglePlanMode(...)` to call `requestPlanMode(..., "toggle")`, then issue a deferred `requestPlanMode(..., "status")` refresh so the status line is updated after Plannotator's own notify/status updates complete.
- [x] Set the local wrapper status under a separate key such as `linear-plannotator` to avoid being cleared by Plannotator's own `plannotator` key.
- [x] Use concise labels such as `[plan:on]`, `[plan:off]`, `[plan:?]` to reduce footer truncation risk.

## Verification
- Run `/reload` in Pi.
- Run `/hotkeys` and confirm only `Ctrl+Super+P` is registered by `linear-plannotator`; no warning for `Ctrl+Alt+P` conflict.
- Press `Ctrl+Cmd+P` twice and confirm:
  - Plan mode toggles on/off.
  - The footer/status line shows the plan indicator after each toggle.
  - Plannotator notification can still appear above the prompt, but the footer indicator persists.

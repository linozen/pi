import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
const PLANNOTATOR_TIMEOUT_MS = 6_000;
const PLAN_STATUS_KEY = "plannotator";

const PLAN_SKELETON = `---
linear: <identifier>
---
# <identifier>: <title>

<description>

## Context
<!-- Codebase conventions, patterns, constraints, and files that matter. -->

## Approach
<!-- Chosen direction and one-line rationale. Note rejected alternatives only when useful. -->

## Plan
<!-- Keep Sync Linear last. -->
- [ ] (implement)
- [ ] **Sync Linear** — publish Outcome and checklist back to Linear.

## Outcome
<!-- Filled at sync time. -->`;

type PlanPhase = "idle" | "planning" | "executing";
type PlannotatorResponse =
	| { status: "handled"; result: { phase: PlanPhase } }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };

function setPlanModeIndicator(ctx: ExtensionContext | ExtensionCommandContext, phase: PlanPhase | "unknown"): void {
	if (phase === "planning" || phase === "executing") {
		ctx.ui.setStatus(PLAN_STATUS_KEY, ctx.ui.theme.fg("warning", "[plan:on]"));
		return;
	}
	if (phase === "unknown") {
		ctx.ui.setStatus(PLAN_STATUS_KEY, ctx.ui.theme.fg("warning", "[plan:?]"));
		return;
	}
	ctx.ui.setStatus(PLAN_STATUS_KEY, ctx.ui.theme.fg("dim", "[plan:off]"));
}

async function requestPlanMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	mode: "enter" | "exit" | "toggle" | "status",
	opts: { notifyUnavailable?: boolean } = {},
): Promise<PlanPhase | null> {
	const response = await new Promise<PlannotatorResponse | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), PLANNOTATOR_TIMEOUT_MS);
		pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
			requestId: randomUUID(),
			action: "plan-mode",
			payload: { mode },
			respond: (value: PlannotatorResponse) => {
				clearTimeout(timer);
				resolve(value);
			},
		});
	});

	if (!response || response.status !== "handled") {
		if (opts.notifyUnavailable) {
			setPlanModeIndicator(ctx, "unknown");
			const reason = response?.status === "error" ? response.error : response?.error;
			ctx.ui.notify(
				`Plannotator plan mode is not available${reason ? `: ${reason}` : ""}. Run /plannotator manually or reload extensions.`,
				"warning",
			);
		}
		return null;
	}

	setPlanModeIndicator(ctx, response.result.phase);
	return response.result.phase;
}

async function togglePlanMode(pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
	const phase = await requestPlanMode(pi, ctx, "toggle", { notifyUnavailable: true });
	if (!phase) return;
	setTimeout(() => {
		void requestPlanMode(pi, ctx, "status", { notifyUnavailable: false });
	}, 50);
}

function send(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
	const busy = !ctx.isIdle();
	pi.sendUserMessage(text, { deliverAs: busy ? "followUp" : undefined });
	ctx.ui.notify(busy ? "Queued as follow-up." : "Started.", "info");
}

function pullPrompt(identifier: string): string {
	return `Run the lightweight Linear ⇄ Plannotator planning flow for ${identifier}.

Use native Pi behavior and the already-configured Linear MCP / Plannotator integrations. Do not use rpiv artifacts, rpiv skills, subagents, or workflow machinery.

Workflow:
1. Fetch the Linear issue with get_issue for ${identifier}.
2. Create plans/<identifier>.md using this skeleton:

${PLAN_SKELETON}

3. Explore the codebase before coding. Write concise findings into Context: conventions, patterns, constraints, and files that matter.
4. Fill Approach and a concrete Plan checklist. Keep **Sync Linear** as the final checklist item.
5. Submit the plan to Plannotator for review. Apply requested plan revisions and re-submit as needed.
6. Stop before implementation unless the user explicitly asks to continue.`;
}

function syncPrompt(reference: string): string {
	return `Run the Sync Linear step for ${reference}.

Use native Pi behavior and the already-configured Linear MCP / Plannotator integrations. Do not use rpiv artifacts, rpiv skills, subagents, or workflow machinery.

Rules:
1. Find the relevant plan file. If it already contains <!--linear-synced-->, stop.
2. Fill ## Outcome with what shipped, what was verified, and any residual follow-up.
3. Render the checklist as ✅/⬜️ lines.
4. create_comment on the Linear issue with Outcome plus the rendered checklist.
5. update_issue to the agreed target status by name. If the status name is uncertain, call list_issue_statuses first.
6. Append <!--linear-synced--> to the plan file.`;
}

export default function linearPlannotator(pi: ExtensionAPI): void {
	let statusPoll: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		for (const delay of [0, 250, 1_000]) {
			setTimeout(() => {
				void requestPlanMode(pi, ctx, "status", { notifyUnavailable: false });
			}, delay);
		}
		statusPoll = setInterval(() => {
			void requestPlanMode(pi, ctx, "status", { notifyUnavailable: false });
		}, 2_000);
	});

	pi.on("session_shutdown", async () => {
		if (statusPoll) clearInterval(statusPoll);
		statusPoll = undefined;
	});

	pi.registerCommand("plan", {
		description: "Enable Plannotator plan mode when disabled; disable it when already active",
		handler: async (_args, ctx) => {
			await togglePlanMode(pi, ctx);
		},
	});

	pi.registerCommand("plannotator", {
		description: "Toggle Plannotator plan mode and refresh the footer indicator",
		handler: async (_args, ctx) => {
			await togglePlanMode(pi, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlSuper("p"), {
		description: "Toggle Plannotator plan mode",
		handler: async (ctx) => {
			await togglePlanMode(pi, ctx);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Refresh the Plannotator plan mode indicator",
		handler: async (_args, ctx) => {
			await requestPlanMode(pi, ctx, "status", { notifyUnavailable: true });
		},
	});

	pi.registerCommand("linear-pull", {
		description: "Pull a Linear issue into a reviewed plan, e.g. /linear-pull ENG-123",
		handler: async (args, ctx) => {
			const identifier = String(args || "").trim();
			if (!identifier) {
				ctx.ui.notify("Usage: /linear-pull ENG-123", "warning");
				return;
			}

			const phase = await requestPlanMode(pi, ctx, "enter", { notifyUnavailable: true });
			if (phase !== "planning") {
				ctx.ui.notify("Linear pull aborted because Plannotator plan mode did not activate.", "warning");
				return;
			}

			send(pi, ctx, pullPrompt(identifier));
		},
	});

	pi.registerCommand("linear-sync", {
		description: "Push a completed plan outcome back to Linear",
		handler: async (args, ctx) => {
			await requestPlanMode(pi, ctx, "status");
			send(pi, ctx, syncPrompt(String(args || "").trim() || "the current plan"));
		},
	});
}

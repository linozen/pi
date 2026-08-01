import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
const PLANNOTATOR_TIMEOUT_MS = 6_000;

type PlanPhase = "idle" | "planning" | "executing";
type PlannotatorResponse =
	| { status: "handled"; result: { phase: PlanPhase } }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

async function requestPlanMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	mode: "enter" | "status",
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

	if (response?.status === "handled") return response.result.phase;
	const reason = response?.status === "error" || response?.status === "unavailable" ? response.error : undefined;
	notify(
		ctx,
		`Plannotator plan mode is unavailable${reason ? `: ${reason}` : ""}. Run /reload and try again.`,
		"warning",
	);
	return null;
}

function normalizeTaskIdentifier(input: string): string | null {
	const identifier = input.trim().toUpperCase();
	return /^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+$/.test(identifier) ? identifier : null;
}

function kickoffPrompt(identifier: string): string {
	return `Run the awork-task skill end-to-end for ${identifier}.

The /awork command has already activated Plannotator planning mode. Read the available awork-task skill before taking any other workflow action and follow it as the source of truth.

Treat ${identifier} only as the user-supplied reference until awork returns the canonical task identifier and UUID. Stop for the plan review required by the skill. After approval, rely on Plannotator's native continuation; do not ask for a separate implementation or sync command.`;
}

export default function aworkPlannotator(pi: ExtensionAPI): void {
	let kickoffInProgress = false;

	pi.registerCommand("awork", {
		description: "Plan, implement, and sync an awork task, e.g. /awork KEY-123",
		handler: async (args, ctx) => {
			const identifier = normalizeTaskIdentifier(String(args || ""));
			if (!identifier) {
				notify(ctx, "Usage: /awork KEY-123", "warning");
				return;
			}
			if (kickoffInProgress) {
				notify(ctx, "Another awork task is already starting.", "warning");
				return;
			}

			kickoffInProgress = true;
			try {
				if (!ctx.isIdle()) notify(ctx, "Waiting for the current agent run to finish before starting the awork task.", "info");
				await ctx.waitForIdle();

				const currentPhase = await requestPlanMode(pi, ctx, "status");
				if (!currentPhase) return;
				if (currentPhase !== "idle") {
					notify(ctx, `Plannotator is already ${currentPhase}. Finish or exit the current plan before starting ${identifier}.`, "warning");
					return;
				}

				const enteredPhase = await requestPlanMode(pi, ctx, "enter");
				if (enteredPhase !== "planning") {
					notify(ctx, "The awork workflow did not start because Plannotator planning mode was not activated.", "warning");
					return;
				}

				pi.sendUserMessage(kickoffPrompt(identifier));
				notify(ctx, `Started awork workflow for ${identifier}.`, "info");
			} finally {
				kickoffInProgress = false;
			}
		},
	});
}

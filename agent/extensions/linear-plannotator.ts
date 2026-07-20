import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
const PLANNOTATOR_TIMEOUT_MS = 6_000;
const PLANNOTATOR_CONTINUE_PROMPT = "Continue with the approved plan.";

function planSkeleton(identifier: string, branch: string, taskDir: string): string {
	return `---
linear: ${identifier}
branch: ${branch}
worktree: ${taskDir}
---
# ${identifier}: <title>

<description>

## Context
<!-- Codebase conventions, patterns, constraints, and files that matter. Include repos likely touched. -->

## Approach
<!-- Chosen direction and one-line rationale. Note rejected alternatives only when useful. -->

## Plan
<!-- Keep Sync Linear last. -->
- [ ] (implement in ${taskDir}/<repo> worktrees on branch ${branch})
- [ ] **Sync Linear** — publish Outcome and checklist back to Linear.

## Outcome
<!-- Filled at sync time. -->`;
}

type PlanPhase = "idle" | "planning" | "executing";
type PlannotatorResponse =
	| { status: "handled"; result: { phase: PlanPhase } }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };

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
			const reason = response?.status === "error" ? response.error : response?.error;
			ctx.ui.notify(
				`Plannotator plan mode is not available${reason ? `: ${reason}` : ""}. Run /plannotator manually or reload extensions.`,
				"warning",
			);
		}
		return null;
	}

	return response.result.phase;
}

async function togglePlanMode(pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
	await requestPlanMode(pi, ctx, "toggle", { notifyUnavailable: true });
}

function send(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
	const busy = !ctx.isIdle();
	pi.sendUserMessage(text, { deliverAs: busy ? "followUp" : undefined });
	ctx.ui.notify(busy ? "Queued as follow-up." : "Started.", "info");
}

function parseIdentifier(input: string): string | null {
	const match = input.trim().match(/^([a-z]+)-(\d+)$/i);
	return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

function branchFor(identifier: string): string {
	return `feature/${identifier.toLowerCase()}`;
}

function taskDirFor(identifier: string): string {
	return `.worktrees/${branchFor(identifier).replace(/^feature\//, "")}`;
}

function pullPrompt(identifier: string): string {
	const branch = branchFor(identifier);
	const taskDir = taskDirFor(identifier);
	return `Run the lightweight Linear ⇄ Plannotator planning flow for ${identifier}.

Use native Pi behavior and the already-configured Linear MCP / Plannotator integrations.

Conventions:
- Linear ID: ${identifier}
- Branch: ${branch}
- Workspace task worktrees: ${taskDir}/<repo-relative-path>
- Keep canonical repo checkouts at the workspace root clean; implementation edits belong in task worktrees on ${branch}.

Workflow:
1. Fetch the Linear issue with get_issue for ${identifier}.
2. Create .plans/${identifier}.md using this skeleton:

${planSkeleton(identifier, branch, taskDir)}

3. Explore the codebase before coding. Write concise findings into Context: conventions, patterns, constraints, files that matter, and which repos likely need ${taskDir}/... worktrees.
4. Fill Approach and a concrete Plan checklist. Keep **Sync Linear** as the final checklist item.
5. Submit the plan to Plannotator for review. Apply requested plan revisions and re-submit as needed.
6. Stop before implementation unless the user explicitly asks to continue.`;
}

function implementPrompt(identifier?: string): string {
	const maybeSpecific = identifier ? `.plans/${identifier}.md` : "the approved `.plans/*.md` plan";
	const mergeReference = identifier?.toLowerCase() ?? "<lowercase-id-from-plan>";
	return `Begin implementation from ${maybeSpecific}.

Use the compacted context plus the approved plan as source of truth.

Rules:
1. Read ${maybeSpecific} first.
2. Confirm the branch/worktree metadata in the plan. Use branch \`feature/<lowercase-id>\` and task worktrees under \`.worktrees/<lowercase-id>/<repo-relative-path>\` when present.
3. Keep canonical workspace-root repo checkouts clean; implementation edits belong in task worktrees.
4. Follow the approved checklist in order. Do not re-plan unless the plan is stale or blocked.
5. Run the relevant checks before reporting completion.
6. Inspect the Harena merge plan before Sync: use \`hr ws merge ${mergeReference}\` in a workspace, or \`hr wt merge ${mergeReference}\` in a single repo. Do not run \`--apply\` or \`--cleanup\` without explicit user approval.
7. Leave **Sync Linear** for /linear-sync after implementation is complete.`;
}

function compactInstructions(reference: string): string {
	return `The plan for ${reference || "the current task"} has been approved and implementation is about to begin.

Preserve only implementation-critical context:
- the approved .plans/*.md plan path and its checklist
- Linear ID, branch, and worktree conventions
- repos and files likely touched
- constraints, rejected alternatives, and decisions from planning
- open risks or user instructions

Remove exploratory chatter and obsolete planning discussion.`;
}

function syncPrompt(reference: string): string {
	return `Run the Sync Linear step for ${reference}.

Use native Pi behavior and the already-configured Linear MCP / Plannotator integrations.

Rules:
1. Find the relevant .plans markdown plan file. If it already contains <!--linear-synced-->, stop.
2. Fill ## Outcome with what shipped, what was verified, whether the Harena merge workflow ran, and any residual follow-up.
3. Render the checklist as ✅/⬜️ lines.
4. create_comment on the Linear issue with Outcome plus the rendered checklist.
5. update_issue to the agreed target status by name. If the status name is uncertain, call list_issue_statuses first.
6. Append <!--linear-synced--> to the plan file.
7. After the Linear update succeeds, delete the temporary plan file unless the user explicitly asked to preserve it.`;
}

export default function linearPlannotator(pi: ExtensionAPI): void {
	let implementationGateArmed = false;
	let pendingIdentifier: string | undefined;

	pi.on("input", (event, ctx) => {
		if (!implementationGateArmed || event.source !== "extension" || event.text.trim() !== PLANNOTATOR_CONTINUE_PROMPT) return;
		ctx.ui.notify(`Plan approved. Run /linear-implement${pendingIdentifier ? ` ${pendingIdentifier}` : ""} to compact planning context and begin implementation.`, "info");
		return { action: "handled" };
	});

	pi.registerCommand("plan", {
		description: "Enable Plannotator plan mode when disabled; disable it when already active",
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
		description: "Show the current Plannotator phase",
		handler: async (_args, ctx) => {
			const phase = await requestPlanMode(pi, ctx, "status", { notifyUnavailable: true });
			if (phase) ctx.ui.notify(`Plannotator phase: ${phase}`, "info");
		},
	});

	pi.registerCommand("linear-pull", {
		description: "Pull a Linear issue into a reviewed plan, e.g. /linear-pull ENG-123",
		handler: async (args, ctx) => {
			const identifier = parseIdentifier(String(args || ""));
			if (!identifier) {
				ctx.ui.notify("Usage: /linear-pull ENG-123", "warning");
				return;
			}

			const phase = await requestPlanMode(pi, ctx, "enter", { notifyUnavailable: true });
			if (phase !== "planning") {
				ctx.ui.notify("Linear pull aborted because Plannotator plan mode did not activate.", "warning");
				return;
			}

			pendingIdentifier = identifier;
			implementationGateArmed = true;
			send(pi, ctx, pullPrompt(identifier));
		},
	});

	pi.registerCommand("linear-implement", {
		description: "Compact after plan approval, then begin implementation, e.g. /linear-implement ENG-123",
		handler: async (args, ctx) => {
			const rawIdentifier = String(args || "").trim();
			const identifier = rawIdentifier ? parseIdentifier(rawIdentifier) : pendingIdentifier;
			if (rawIdentifier && !identifier) {
				ctx.ui.notify("Usage: /linear-implement ENG-123", "warning");
				return;
			}
			implementationGateArmed = false;
			await requestPlanMode(pi, ctx, "exit", { notifyUnavailable: false });
			ctx.ui.notify("Compacting approved plan context before implementation.", "info");
			ctx.compact({
				customInstructions: compactInstructions(identifier ?? "the current task"),
				onComplete: () => {
					ctx.ui.notify("Compaction complete. Starting implementation.", "info");
					pi.sendUserMessage(implementPrompt(identifier), { deliverAs: "followUp" });
				},
				onError: (error) => {
					ctx.ui.notify(`Compaction failed; implementation not started: ${error.message}`, "error");
				},
			});
		},
	});

	pi.registerCommand("linear-sync", {
		description: "Push a completed plan outcome back to Linear",
		handler: async (args, ctx) => {
			const rawIdentifier = String(args || "").trim();
			const identifier = rawIdentifier ? parseIdentifier(rawIdentifier) : pendingIdentifier;
			if (rawIdentifier && !identifier) {
				ctx.ui.notify("Usage: /linear-sync ENG-123", "warning");
				return;
			}
			send(pi, ctx, syncPrompt(identifier ?? "the current plan"));
		},
	});
}

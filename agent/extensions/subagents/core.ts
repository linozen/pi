// Pure logic for the subagents extension.
// No runtime imports from Pi packages so `node --test` can exercise it directly.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const TOOL_NAME = "subagent";
export const RESULT_TOOL_NAME = "subagent_result";
export const OUTPUT_LIMIT = 20_000;
export const LIVE_TRANSCRIPT_LIMIT = 16_000;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_REVIEW_TIMEOUT_SECONDS = 300;
export const MAX_REVIEWS_PER_REQUEST = 2;
export const PROGRESS_INTERVAL_MS = 15_000;
export const MAX_ACTIVE_JOBS = 2;
export const MAX_RETAINED_JOBS = 32;
// Absolute lifetime ceiling for a child process regardless of window extensions.
export const MIN_HARD_TIMEOUT_SECONDS = 1_800;

// Lower-cost subagent default models keyed by the parent session's active provider.
// Add an entry per provider you actually run; providers without an entry fall back
// to the parent session's own model (or, if that is unset, the child's settings default).
const DEFAULT_SUBAGENT_MODELS: Record<string, string> = {
	"openai-codex": "openai-codex/gpt-6.1-sol", // ChatGPT subscription
	openrouter: "deepseek/deepseek-v4.1-flash", // Sep 2026 agentic flash; beats V4 Pro per DeepSeek
	mistral: "mistral/devstral-latest", // herdr local proxy profile; agentic, cheap, no reasoning
};

// Per-profile overrides on top of the provider-wide defaults, keyed by profile name
// then provider. Sparse on purpose: a missing entry falls back to the provider default.
// Evidence profiles get the cheapest capable tier; review and implementation get the
// strong agentic picks; librarian gets a reasoning-tuned model where the coding
// default is the wrong shape.
const PROFILE_SUBAGENT_MODELS: Record<string, Record<string, string>> = {
	scout: {
		"openai-codex": "openai-codex/gpt-6-luna", // cheap tier for evidence runs
		openrouter: "z-ai/glm-5.3-flash", // $0.075/$0.25, 1M ctx, reasoning
	},
	research: {
		"openai-codex": "openai-codex/gpt-6-luna",
		openrouter: "z-ai/glm-5.3-flash",
	},
	review: {
		mistral: "mistral/zai-glm-5-3", // reasoning-capable reviewer; devstral has no reasoning
		openrouter: "deepseek/deepseek-v4-pro", // 96.4% SWE-bench Verified class, $0.96/$1.91
	},
	librarian: {
		mistral: "mistral/mistral-medium-3.5", // research/judgment workload with web tools
	},
	implementation: {
		"openai-codex": "openai-codex/gpt-6-astra", // agent-tuned flagship
		openrouter: "deepseek/deepseek-v4-pro",
	},
};

export function resolveDefaultModel(profileName: string, ctxModel: { provider: string; id: string } | undefined): string | undefined {
	if (!ctxModel) return undefined;
	return PROFILE_SUBAGENT_MODELS[profileName]?.[ctxModel.provider]
		?? DEFAULT_SUBAGENT_MODELS[ctxModel.provider]
		?? `${ctxModel.provider}/${ctxModel.id}`;
}

export type AgentProfile = {
	name: string;
	description: string;
	instructions: string;
	tools?: string;
	model?: string;
	thinking?: string;
	timeoutSeconds?: number;
	disableExtensions?: boolean;
	path?: string;
};

export const BUILTIN_AGENTS: Record<string, AgentProfile> = {
	general: {
		name: "general",
		description: "General-purpose subagent with the normal Pi toolset.",
		thinking: "medium",
		instructions: "You are a focused subagent. Complete the delegated task independently, then return a concise report with findings, changed files, verification, and open risks.",
	},
	research: {
		name: "research",
		description: "Read-only research subagent for codebase exploration and fact-finding.",
		tools: "read,grep,find,ls",
		thinking: "minimal",
		disableExtensions: true,
		instructions: "You are a read-only research subagent. Do not modify files. Return concrete findings with file paths and line references where possible.",
	},
	review: {
		name: "review",
		description: "Read-only review subagent for correctness blockers.",
		tools: "read,grep,find,ls",
		thinking: "medium",
		timeoutSeconds: MAX_REVIEW_TIMEOUT_SECONDS,
		disableExtensions: true,
		instructions: "You are a read-only code review subagent. Do not modify files. Report correctness blockers only, rank them by impact, and include exact file paths.",
	},
	implementation: {
		name: "implementation",
		description: "Implementation subagent with the normal Pi toolset.",
		thinking: "medium",
		instructions: "You are an implementation subagent. Make the smallest correct change, avoid new dependencies, and leave one runnable verification command in your final report.",
	},
};

export type SubagentJobStatus = "running" | "timed_out" | "completed" | "failed" | "cancelled";

export function isActiveStatus(status: SubagentJobStatus): boolean {
	return status === "running" || status === "timed_out";
}

export type SubagentMetrics = {
	toolCalls: number;
	toolCompleted: number;
	toolErrors: number;
	activeTools: number;
	toolsByName: Record<string, number>;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	startupMs: number;
	firstOutputMs: number;
	durationMs: number;
};

export function emptyMetrics(): SubagentMetrics {
	return {
		toolCalls: 0,
		toolCompleted: 0,
		toolErrors: 0,
		activeTools: 0,
		toolsByName: {},
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		startupMs: 0,
		firstOutputMs: 0,
		durationMs: 0,
	};
}

/** Bounded human-readable activity log for the live job view. */
export type SubagentLive = {
	transcript: string;
	streaming: string;
	lastTool?: string;
};

export type SubagentRunParams = {
	agent?: string;
	description: string;
	prompt: string;
	tools?: string;
	model?: string;
	thinking?: string;
	timeout_seconds?: number;
};

export type SubagentRunResult = {
	profile: AgentProfile;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	metrics: SubagentMetrics;
	reason: string;
	text: string;
};

/** Handle through which the parent can push a job's timeout window outward. */
export type RunControl = {
	extend?: (seconds: number) => void;
};

/** Minimal job shape shared by result text and the live view builders. */
export type JobSnapshot = {
	id: string;
	description: string;
	prompt: string;
	profile: AgentProfile;
	model?: string;
	windowSeconds: number;
	extensions: number;
	status: SubagentJobStatus;
	startedAt: number;
	finishedAt?: number;
	metrics: SubagentMetrics;
	live: SubagentLive;
	result?: SubagentRunResult;
	error?: string;
};

export function trimOutput(value: string, limit = OUTPUT_LIMIT): string {
	if (value.length <= limit) return value;
	const suffix = "\n\n[output truncated]";
	return `${value.slice(0, limit - suffix.length)}${suffix}`;
}

export function appendOutputTail(current: string, chunk: string, limit = OUTPUT_LIMIT): string {
	const next = current + chunk;
	return next.length <= limit ? next : next.slice(-limit);
}

export function appendLive(live: SubagentLive, text: string, limit = LIVE_TRANSCRIPT_LIMIT): void {
	const next = live.transcript + text;
	live.transcript = next.length <= limit ? next : next.slice(-limit);
}

export function subagentDedupeKey(profile: AgentProfile, prompt: string): string {
	return `${profile.name}\n${prompt.trim().replace(/\s+/g, " ").toLowerCase()}`;
}

export function metadata(text: string, key: string): string | undefined {
	return text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

export function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	if (/^(true|yes|1|on)$/i.test(value)) return true;
	if (/^(false|no|0|off)$/i.test(value)) return false;
	return undefined;
}

export function parseTimeout(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function parseAgentFile(path: string): AgentProfile | undefined {
	const name = basename(path, ".md");
	const text = readFileSync(path, "utf8");
	return {
		name,
		description: metadata(text, "description") ?? `Custom ${name} subagent.`,
		tools: metadata(text, "tools"),
		model: metadata(text, "model"),
		thinking: metadata(text, "thinking"),
		timeoutSeconds: parseTimeout(metadata(text, "timeout_seconds")),
		disableExtensions: parseBoolean(metadata(text, "no_extensions")),
		instructions: text.trim(),
		path,
	};
}

export function loadAgentDir(agents: Record<string, AgentProfile>, dir: string): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const profile = parseAgentFile(join(dir, entry.name));
		if (profile) agents[profile.name] = profile;
	}
}

export function loadAgents(cwd: string, includeProjectProfiles: boolean): Record<string, AgentProfile> {
	const agents = { ...BUILTIN_AGENTS };
	loadAgentDir(agents, join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "subagents"));
	if (includeProjectProfiles) loadAgentDir(agents, join(cwd, ".pi", "subagents"));
	return agents;
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part === "string") return part;
		if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
		return "";
	}).join("");
}

export function metricsText(metrics: SubagentMetrics): string {
	const tokens = metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens;
	const cost = metrics.cost ? `, $${metrics.cost.toFixed(4)}` : "";
	const timings = [
		metrics.startupMs ? `startup ${metrics.startupMs}ms` : undefined,
		metrics.firstOutputMs ? `first output ${metrics.firstOutputMs}ms` : undefined,
		metrics.durationMs ? `total ${metrics.durationMs}ms` : undefined,
	].filter(Boolean).join(", ");
	return `tools ${metrics.toolCompleted}/${metrics.toolCalls}${metrics.activeTools ? ` (${metrics.activeTools} active)` : ""}, tokens ${tokens} (in ${metrics.inputTokens}, out ${metrics.outputTokens}, cache ${metrics.cacheReadTokens}/${metrics.cacheWriteTokens})${cost}${timings ? `, latency ${timings}` : ""}`;
}

export function argsSummary(args: unknown, limit = 160): string {
	if (args === undefined || args === null) return "";
	let text: string;
	if (typeof args === "string") text = args;
	else {
		try {
			text = JSON.stringify(args);
		} catch {
			text = String(args);
		}
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export type ChildEventEffect = {
	progress?: string;
	assistantFailure?: string | null;
};

/**
 * Fold one JSON-mode child event into metrics and the live transcript.
 * Returns a short progress line for status updates, and `assistantFailure`
 * (present but null when a previously failing assistant message completed fine).
 */
export function applyChildEvent(event: Record<string, any>, metrics: SubagentMetrics, live: SubagentLive): ChildEventEffect | undefined {
	if (event.type === "tool_execution_start") {
		const name = typeof event.toolName === "string" ? event.toolName : "unknown";
		metrics.toolCalls++;
		metrics.activeTools++;
		metrics.toolsByName[name] = (metrics.toolsByName[name] ?? 0) + 1;
		live.lastTool = `${name} ${argsSummary(event.args)}`.trim();
		appendLive(live, `\n→ ${live.lastTool}`);
		return { progress: `tool started: ${name}` };
	}
	if (event.type === "tool_execution_end") {
		const name = typeof event.toolName === "string" ? event.toolName : "unknown";
		metrics.toolCompleted++;
		metrics.activeTools = Math.max(0, metrics.activeTools - 1);
		if (event.isError) metrics.toolErrors++;
		appendLive(live, `\n← ${name}${event.isError ? " ✗" : ""}`);
		return { progress: `tool finished: ${name}${event.isError ? " (error)" : ""}` };
	}
	if (event.type === "message_update" && event.assistantMessageEvent) {
		const nested = event.assistantMessageEvent as Record<string, any>;
		if (nested.type === "text_delta" && typeof nested.delta === "string") {
			live.streaming = (live.streaming + nested.delta).slice(-4_000);
		}
		return undefined;
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const usage = event.message.usage ?? {};
		metrics.inputTokens += usage.input ?? 0;
		metrics.outputTokens += usage.output ?? 0;
		metrics.cacheReadTokens += usage.cacheRead ?? 0;
		metrics.cacheWriteTokens += usage.cacheWrite ?? 0;
		metrics.cost += usage.cost?.total ?? 0;
		const messageText = textFromContent(event.message.content).trim();
		live.streaming = "";
		if (messageText) appendLive(live, `\n\n${messageText}`);
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
			return { assistantFailure: event.message.errorMessage || `Assistant stopped: ${event.message.stopReason}` };
		}
		return { assistantFailure: null };
	}
	return undefined;
}

export type ReasonInput = {
	exitCode: number | null;
	spawnError?: string;
	aborted?: boolean;
	killedForTimeout?: boolean;
	hardKilled?: boolean;
	timeoutSeconds?: number;
	hardTimeoutSeconds?: number;
	assistantFailure?: string;
};

export function buildReason(input: ReasonInput): string {
	if (input.spawnError) return `spawn failed: ${input.spawnError}`;
	if (input.aborted) return "cancelled by parent or shutdown";
	if (input.hardKilled) return `killed after exceeding ${input.hardTimeoutSeconds ?? "?"}s hard timeout ceiling`;
	if (input.killedForTimeout) return `killed after exceeding ${input.timeoutSeconds ?? "?"}s timeout window`;
	if (input.assistantFailure) return `assistant stopped: ${input.assistantFailure}`;
	if (input.exitCode === 0) return "completed";
	if (input.exitCode === null) return "terminated by signal";
	return `exited with code ${input.exitCode}`;
}

export function buildResultText(profile: AgentProfile, result: Omit<SubagentRunResult, "text" | "profile">): string {
	// Reason and stderr first: the model must see why a job failed before partial output.
	return trimOutput([
		`subagent: ${profile.name}`,
		profile.path ? `profile: ${profile.path}` : "",
		`exit: ${result.exitCode}`,
		`reason: ${result.reason}`,
		`metrics: ${metricsText(result.metrics)}`,
		result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
		result.stdout.trim(),
	].filter(Boolean).join("\n\n"));
}

export function buildReportPrompt(profile: AgentProfile): string {
	return [
		`Subagent profile: ${profile.name}`,
		profile.instructions,
		"Return only the final report. Do not ask the parent for interactive clarification; state assumptions instead.",
		"Use this exact report shape when applicable:",
		"## Result\n## Files inspected\n## Findings\n## Verification\n## Risks / assumptions",
	].join("\n\n");
}

export function buildRunArgs(profile: AgentProfile, params: SubagentRunParams, trusted: boolean, defaultModel?: string): { args: string[]; timeoutSeconds: number; model?: string } {
	const requestedTimeout = params.timeout_seconds ?? profile.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const positiveTimeout = Number.isFinite(requestedTimeout) ? Math.max(1, requestedTimeout) : DEFAULT_TIMEOUT_SECONDS;
	const timeoutSeconds = profile.name === "review" ? Math.min(positiveTimeout, MAX_REVIEW_TIMEOUT_SECONDS) : positiveTimeout;
	const args = [
		"--mode",
		"json",
		"--name",
		`subagent: ${params.description}`,
		"--exclude-tools",
		`${TOOL_NAME},${RESULT_TOOL_NAME}`,
		"--system-prompt",
		buildReportPrompt(profile),
		"--no-session",
		"--offline",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
	];

	if (trusted) args.push("--approve");
	if (profile.disableExtensions) args.push("--no-extensions");
	const tools = profile.tools ?? params.tools;
	if (tools) args.push("--tools", tools);
	const model = params.model ?? profile.model ?? defaultModel;
	if (model) args.push("--model", model);
	const requestedModelSetsThinking = params.model ? /:(?:off|minimal|low|medium|high|xhigh|max)$/.test(params.model) : false;
	const thinking = params.thinking ?? (requestedModelSetsThinking ? undefined : profile.thinking);
	if (thinking) args.push("--thinking", thinking);
	args.push([`Task: ${params.description}`, params.prompt].join("\n\n"));

	return { args, timeoutSeconds, model };
}

export function formatAgentLine(agent: AgentProfile, defaultModel: string | undefined): string {
	const defaults = [
		agent.tools ? `tools: ${agent.tools}` : undefined,
		`model: ${agent.model ?? defaultModel ?? "session default"}`,
		agent.thinking ? `thinking: ${agent.thinking}` : undefined,
		agent.timeoutSeconds ? `timeout: ${agent.timeoutSeconds}s` : undefined,
		agent.disableExtensions ? "no-extensions" : undefined,
	].filter(Boolean).join(", ");
	return `- ${agent.name}: ${agent.description}${defaults ? ` [${defaults}]` : ""}${agent.path ? ` (${agent.path})` : ""}`;
}

export function profileWarnings(agent: AgentProfile): string[] {
	const warnings: string[] = [];
	if (agent.thinking && !/^(off|minimal|low|medium|high|xhigh)$/.test(agent.thinking)) warnings.push(`${agent.name}: unknown thinking level '${agent.thinking}'`);
	if (agent.timeoutSeconds !== undefined && (!Number.isFinite(agent.timeoutSeconds) || agent.timeoutSeconds <= 0)) warnings.push(`${agent.name}: timeout_seconds must be positive`);
	return warnings;
}

export function timeoutDecisionText(job: JobSnapshot, elapsedSeconds: number): string {
	return [
		`Subagent job ${job.id} (${job.profile.name}) exceeded its ${job.windowSeconds}s timeout window after ${elapsedSeconds}s and is still running.`,
		`Progress so far: ${metricsText(job.metrics)}.`,
		job.live.lastTool ? `Last activity: ${job.live.lastTool}` : "",
		`It was not killed. Decide now: call ${RESULT_TOOL_NAME} with job_id "${job.id}" and extend_seconds=<seconds> to grant another window, or cancel=true to stop it. Otherwise leave it running and collect the result later.`,
	].filter(Boolean).join("\n");
}

export function jobText(job: JobSnapshot, now = Date.now()): string {
	const elapsedMs = (job.finishedAt ?? now) - job.startedAt;
	const decision = job.status === "timed_out"
		? [
			`The job is still running; it was not killed.`,
			`Decide: call ${RESULT_TOOL_NAME} with job_id "${job.id}" and extend_seconds=<seconds> to grant another window, or cancel=true to stop it.`,
		].join("\n")
		: "";
	return trimOutput([
		`subagent job: ${job.id}`,
		`status: ${job.status}`,
		`profile: ${job.profile.name}`,
		`description: ${job.description}`,
		`elapsed: ${elapsedMs}ms`,
		job.extensions ? `timeout windows exceeded: ${job.extensions}` : "",
		decision,
		job.result?.text,
		job.error ? `error: ${job.error}` : "",
	].filter(Boolean).join("\n\n"));
}

export function statusStyle(status: SubagentJobStatus): { icon: string; color: "success" | "warning" | "error" } {
	switch (status) {
		case "completed":
			return { icon: "✓", color: "success" };
		case "running":
		case "timed_out":
			return { icon: status === "running" ? "◌" : "◷", color: "warning" };
		default:
			return { icon: "✗", color: "error" };
	}
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export type JobRow = {
	id: string;
	icon: string;
	color: "success" | "warning" | "error";
	active: boolean;
	text: string;
};

export function sortJobs<T extends JobSnapshot>(jobs: T[]): T[] {
	return [...jobs].sort((left, right) => {
		const leftActive = isActiveStatus(left.status);
		const rightActive = isActiveStatus(right.status);
		if (leftActive !== rightActive) return leftActive ? -1 : 1;
		if (leftActive) return right.startedAt - left.startedAt;
		return (right.finishedAt ?? 0) - (left.finishedAt ?? 0);
	});
}

export function buildJobRows(jobs: JobSnapshot[], now = Date.now()): JobRow[] {
	return sortJobs(jobs).map((job) => {
		const { icon, color } = statusStyle(job.status);
		const elapsed = formatElapsed((job.finishedAt ?? now) - job.startedAt);
		const tools = `tools ${job.metrics.toolCompleted}/${job.metrics.toolCalls}${job.metrics.activeTools ? ` (${job.metrics.activeTools} active)` : ""}`;
		const flag = job.status === "timed_out" ? " · window exceeded, awaiting decision" : "";
		return { id: job.id, icon, color, active: isActiveStatus(job.status), text: `${job.id} ${job.profile.name} ${elapsed} ${tools}${flag} · ${job.description}` };
	});
}

export type DetailLine = {
	text: string;
	color?: "success" | "warning" | "error" | "dim" | "muted" | "accent" | "toolOutput" | "customMessageText";
};

export function buildJobDetailLines(job: JobSnapshot, now = Date.now()): DetailLine[] {
	const { icon, color } = statusStyle(job.status);
	const lines: DetailLine[] = [
		{ text: `${icon} job ${job.id} — ${job.status}`, color },
		{
			text: `${job.profile.name}${job.model ? ` · ${job.model}` : ""} · window ${job.windowSeconds}s${job.extensions ? ` · windows exceeded ${job.extensions}` : ""} · elapsed ${formatElapsed((job.finishedAt ?? now) - job.startedAt)}`,
			color: "dim",
		},
		{ text: job.description, color: "customMessageText" },
		{ text: metricsText(job.metrics), color: "muted" },
	];
	const promptHead = job.prompt.split("\n").slice(0, 8);
	if (promptHead.length) {
		lines.push({ text: "", color: undefined });
		for (const line of promptHead) lines.push({ text: line, color: "dim" });
		if (job.prompt.split("\n").length > promptHead.length) lines.push({ text: "… (prompt truncated)", color: "dim" });
	}
	lines.push({ text: "", color: undefined });
	const transcript = job.live.transcript + (job.live.streaming ? `\n\n${job.live.streaming}` : "");
	for (const line of transcript.split("\n")) lines.push({ text: line, color: "toolOutput" });
	if (job.result?.text) {
		lines.push({ text: "", color: undefined });
		for (const line of job.result.text.split("\n")) lines.push({ text: line, color: "customMessageText" });
	}
	if (job.error) lines.push({ text: `error: ${job.error}`, color: "error" });
	return lines;
}

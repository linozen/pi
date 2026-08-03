import { keyHint, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

const TOOL_NAME = "subagent";
const RESULT_TOOL_NAME = "subagent_result";
const OUTPUT_LIMIT = 60_000;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const PROGRESS_INTERVAL_MS = 15_000;
const MAX_ACTIVE_JOBS = 8;
const MAX_RETAINED_JOBS = 32;
const DEFAULT_SUBAGENT_MODEL = "openai-codex/gpt-5.6-luna";

const BUILTIN_AGENTS: Record<string, AgentProfile> = {
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
		description: "Read-only review subagent for bugs, regressions, and simplification opportunities.",
		tools: "read,grep,find,ls",
		thinking: "high",
		disableExtensions: true,
		instructions: "You are a read-only code review subagent. Do not modify files. Rank findings by impact and include exact file paths.",
	},
	implementation: {
		name: "implementation",
		description: "Implementation subagent with the normal Pi toolset.",
		thinking: "medium",
		instructions: "You are an implementation subagent. Make the smallest correct change, avoid new dependencies, and leave one runnable verification command in your final report.",
	},
};

type AgentProfile = {
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

type SubagentRunParams = {
	agent?: string;
	description: string;
	prompt: string;
	tools?: string;
	model?: string;
	thinking?: string;
	timeout_seconds?: number;
};

type SubagentRunResult = {
	profile: AgentProfile;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	metrics: SubagentMetrics;
	text: string;
};

type PreparedSubagentRun = {
	profile: AgentProfile;
	args: string[];
	timeoutMs: number;
};

type SubagentJobStatus = "running" | "completed" | "failed" | "cancelled";

type SubagentJob = {
	id: string;
	description: string;
	profile: AgentProfile;
	status: SubagentJobStatus;
	startedAt: number;
	finishedAt?: number;
	controller: AbortController;
	promise: Promise<void>;
	result?: SubagentRunResult;
	error?: string;
};

type SubagentJobDetails = {
	jobId: string;
	status: SubagentJobStatus;
	description: string;
	agent: string;
	profilePath?: string;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	metrics?: SubagentMetrics;
	stderr?: string;
	error?: string;
};

type SubagentMetrics = {
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

type RunPiOptions = {
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onTimeout?: (elapsedSeconds: number, outputChars: number, metrics: SubagentMetrics) => Promise<boolean>;
};

function trimOutput(value: string): string {
	if (value.length <= OUTPUT_LIMIT) return value;
	return `${value.slice(0, OUTPUT_LIMIT)}\n\n[truncated ${value.length - OUTPUT_LIMIT} chars]`;
}

function appendOutputTail(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
}

function metadata(text: string, key: string): string | undefined {
	return text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	if (/^(true|yes|1|on)$/i.test(value)) return true;
	if (/^(false|no|0|off)$/i.test(value)) return false;
	return undefined;
}

function parseTimeout(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function parseAgentFile(path: string): AgentProfile | undefined {
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

function loadAgentDir(agents: Record<string, AgentProfile>, dir: string): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const profile = parseAgentFile(join(dir, entry.name));
		if (profile) agents[profile.name] = profile;
	}
}

function loadAgents(cwd: string, includeProjectProfiles: boolean): Record<string, AgentProfile> {
	const agents = { ...BUILTIN_AGENTS };
	loadAgentDir(agents, join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "subagents"));
	if (includeProjectProfiles) loadAgentDir(agents, join(cwd, ".pi", "subagents"));
	return agents;
}

function emptyMetrics(): SubagentMetrics {
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

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part === "string") return part;
		if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
		return "";
	}).join("");
}

function metricsText(metrics: SubagentMetrics): string {
	const tokens = metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens;
	const cost = metrics.cost ? `, $${metrics.cost.toFixed(4)}` : "";
	const timings = [
		metrics.startupMs ? `startup ${metrics.startupMs}ms` : undefined,
		metrics.firstOutputMs ? `first output ${metrics.firstOutputMs}ms` : undefined,
		metrics.durationMs ? `total ${metrics.durationMs}ms` : undefined,
	].filter(Boolean).join(", ");
	return `tools ${metrics.toolCompleted}/${metrics.toolCalls}${metrics.activeTools ? ` (${metrics.activeTools} active)` : ""}, tokens ${tokens} (in ${metrics.inputTokens}, out ${metrics.outputTokens}, cache ${metrics.cacheReadTokens}/${metrics.cacheWriteTokens})${cost}${timings ? `, latency ${timings}` : ""}`;
}

function updateMetricsFromEvent(event: Record<string, any>, metrics: SubagentMetrics): string | undefined {
	if (event.type === "tool_execution_start") {
		const name = typeof event.toolName === "string" ? event.toolName : "unknown";
		metrics.toolCalls++;
		metrics.activeTools++;
		metrics.toolsByName[name] = (metrics.toolsByName[name] ?? 0) + 1;
		return `tool started: ${name}`;
	}
	if (event.type === "tool_execution_end") {
		metrics.toolCompleted++;
		metrics.activeTools = Math.max(0, metrics.activeTools - 1);
		if (event.isError) metrics.toolErrors++;
		return `tool finished: ${typeof event.toolName === "string" ? event.toolName : "unknown"}${event.isError ? " (error)" : ""}`;
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const usage = event.message.usage ?? {};
		metrics.inputTokens += usage.input ?? 0;
		metrics.outputTokens += usage.output ?? 0;
		metrics.cacheReadTokens += usage.cacheRead ?? 0;
		metrics.cacheWriteTokens += usage.cacheWrite ?? 0;
		metrics.cost += usage.cost?.total ?? 0;
	}
	return undefined;
}

function runPi(args: string[], cwd: string, timeoutMs: number, options: RunPiOptions = {}): Promise<{ exitCode: number | null; stdout: string; stderr: string; metrics: SubagentMetrics }> {
	return new Promise((resolve) => {
		const startedAt = performance.now();
		const child = spawn("pi", args, {
			cwd,
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutTail = "";
		let stdoutLineBuffer = "";
		let finalAssistantText = "";
		let assistantFailure = "";
		let stderrTail = "";
		let outputChars = 0;
		const metrics = emptyMetrics();
		let killedForTimeout = false;
		let aborted = false;
		let settled = false;
		let awaitingTimeoutDecision = false;
		let deadline = Date.now() + timeoutMs;
		let lastOutputAt = Date.now();
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const timeoutStartedAt = Date.now();
		const timeoutSeconds = Math.round(timeoutMs / 1000);

		const appendStderr = (text: string): void => {
			stderrTail = appendOutputTail(stderrTail, text);
		};
		const terminate = (): void => {
			child.kill("SIGTERM");
			if (!killTimer) {
				killTimer = setTimeout(() => {
					if (!settled) child.kill("SIGKILL");
				}, 5_000);
				killTimer.unref();
			}
		};
		const scheduleTimeoutReview = (): void => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			timeoutTimer = setTimeout(() => void reviewTimeout(), Math.max(1, deadline - Date.now()));
			timeoutTimer.unref();
		};
		const reviewTimeout = async (): Promise<void> => {
			if (settled || awaitingTimeoutDecision) return;
			awaitingTimeoutDecision = true;
			const elapsedSeconds = Math.round((Date.now() - timeoutStartedAt) / 1000);
			let kill = true;
			try {
				kill = options.onTimeout ? await options.onTimeout(elapsedSeconds, outputChars, metrics) : true;
			} catch (error) {
				appendStderr(`\nTimeout confirmation failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (settled) return;
			if (kill) {
				killedForTimeout = true;
				appendStderr(`\nKilled after exceeding ${timeoutSeconds} second timeout window.`);
				terminate();
				return;
			}
			appendStderr(`\nOperator allowed subagent to continue after ${elapsedSeconds}s.`);
			deadline = Date.now() + timeoutMs;
			awaitingTimeoutDecision = false;
			scheduleTimeoutReview();
		};

		options.onProgress?.(`subagent pid ${child.pid ?? "?"}: started, timeout review in ${timeoutSeconds}s`);
		const abort = () => {
			aborted = true;
			terminate();
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		scheduleTimeoutReview();

		const progress = setInterval(() => {
			if (settled) return;
			const now = Date.now();
			const elapsedSeconds = Math.round((now - timeoutStartedAt) / 1000);
			const remainingSeconds = Math.max(0, Math.round((deadline - now) / 1000));
			const outputAgeSeconds = Math.round((now - lastOutputAt) / 1000);
			const percent = Math.min(99, Math.round(((timeoutMs - Math.max(0, deadline - now)) / timeoutMs) * 100));
			options.onProgress?.(`subagent pid ${child.pid ?? "?"}: running ${elapsedSeconds}s, timeout window ${percent}%, ${remainingSeconds}s before review, ${metricsText(metrics)}, output ${outputChars} chars, last output ${outputAgeSeconds}s ago`);
		}, PROGRESS_INTERVAL_MS);

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			outputChars += text.length;
			stdoutTail = appendOutputTail(stdoutTail, text);
			stdoutLineBuffer += text;
			const lines = stdoutLineBuffer.split("\n");
			stdoutLineBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as Record<string, any>;
					const elapsedMs = Math.round(performance.now() - startedAt);
					if (!metrics.startupMs) metrics.startupMs = elapsedMs;
					if (!metrics.firstOutputMs && (
						(event.type === "message_update" && event.message?.role === "assistant")
						|| (event.type === "message_end" && event.message?.role === "assistant")
						|| event.type === "tool_execution_start"
					)) metrics.firstOutputMs = elapsedMs;
					const update = updateMetricsFromEvent(event, metrics);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						const messageText = textFromContent(event.message.content).trim();
						if (messageText) finalAssistantText = trimOutput(messageText);
						if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
							assistantFailure = event.message.errorMessage || `Assistant stopped: ${event.message.stopReason}`;
						} else {
							assistantFailure = "";
						}
					}
					if (update) options.onProgress?.(`subagent pid ${child.pid ?? "?"}: ${update}; ${metricsText(metrics)}`);
				} catch {
					// Plain output is retained in the bounded stdout tail.
				}
			}
			lastOutputAt = Date.now();
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			outputChars += text.length;
			appendStderr(text);
			lastOutputAt = Date.now();
		});
		child.on("error", (error) => {
			appendStderr(error.message);
			lastOutputAt = Date.now();
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			metrics.durationMs = Math.round(performance.now() - startedAt);
			clearInterval(progress);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			if (assistantFailure) appendStderr(`\n${assistantFailure}`);
			resolve({ exitCode: killedForTimeout || aborted || assistantFailure ? -1 : exitCode, stdout: trimOutput(finalAssistantText || stdoutTail), stderr: stderrTail, metrics });
		});
	});
}

function buildReportPrompt(profile: AgentProfile): string {
	return [
		`Subagent profile: ${profile.name}`,
		profile.instructions,
		"Return only the final report. Do not ask the parent for interactive clarification; state assumptions instead.",
		"Use this exact report shape when applicable:",
		"## Result\n## Files inspected\n## Findings\n## Verification\n## Risks / assumptions",
	].join("\n\n");
}

function buildRunArgs(profile: AgentProfile, params: SubagentRunParams, trusted: boolean): { args: string[]; timeoutMs: number } {
	const requestedTimeout = params.timeout_seconds ?? profile.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const timeoutSeconds = Number.isFinite(requestedTimeout) ? Math.max(1, requestedTimeout) : DEFAULT_TIMEOUT_SECONDS;
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
	const model = params.model ?? profile.model ?? DEFAULT_SUBAGENT_MODEL;
	if (model) args.push("--model", model);
	const requestedModelSetsThinking = params.model ? /:(?:off|minimal|low|medium|high|xhigh|max)$/.test(params.model) : false;
	const thinking = params.thinking ?? (requestedModelSetsThinking ? undefined : profile.thinking);
	if (thinking) args.push("--thinking", thinking);
	args.push([`Task: ${params.description}`, params.prompt].join("\n\n"));

	return { args, timeoutMs: timeoutSeconds * 1000 };
}

function prepareSubagent(params: SubagentRunParams, ctx: ExtensionContext | ExtensionCommandContext): PreparedSubagentRun {
	const agents = loadAgents(ctx.cwd, ctx.isProjectTrusted());
	const requestedProfile = params.agent ?? "general";
	const profile = agents[requestedProfile];
	if (!profile) throw new Error(`Unknown subagent profile '${requestedProfile}'. Run /subagents to list available profiles.`);
	const { args, timeoutMs } = buildRunArgs(profile, params, ctx.isProjectTrusted());
	return { profile, args, timeoutMs };
}

async function runSubagent(params: SubagentRunParams, ctx: ExtensionContext | ExtensionCommandContext, options: RunPiOptions = {}, prepared = prepareSubagent(params, ctx)): Promise<SubagentRunResult> {
	const { profile, args, timeoutMs } = prepared;
	const result = await runPi(args, ctx.cwd, timeoutMs, options);
	const text = [
		`subagent: ${profile.name}`,
		profile.path ? `profile: ${profile.path}` : "",
		`exit: ${result.exitCode}`,
		`metrics: ${metricsText(result.metrics)}`,
		result.stdout.trim(),
		result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	return { profile, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, metrics: result.metrics, text };
}

function formatAgentLine(agent: AgentProfile): string {
	const defaults = [
		agent.tools ? `tools: ${agent.tools}` : undefined,
		`model: ${agent.model ?? DEFAULT_SUBAGENT_MODEL}`,
		agent.thinking ? `thinking: ${agent.thinking}` : undefined,
		agent.timeoutSeconds ? `timeout: ${agent.timeoutSeconds}s` : undefined,
		agent.disableExtensions ? "no-extensions" : undefined,
	].filter(Boolean).join(", ");
	return `- ${agent.name}: ${agent.description}${defaults ? ` [${defaults}]` : ""}${agent.path ? ` (${agent.path})` : ""}`;
}

function profileWarnings(agent: AgentProfile): string[] {
	const warnings: string[] = [];
	if (agent.thinking && !/^(off|minimal|low|medium|high|xhigh)$/.test(agent.thinking)) warnings.push(`${agent.name}: unknown thinking level '${agent.thinking}'`);
	if (agent.timeoutSeconds !== undefined && (!Number.isFinite(agent.timeoutSeconds) || agent.timeoutSeconds <= 0)) warnings.push(`${agent.name}: timeout_seconds must be positive`);
	return warnings;
}

function jobText(job: SubagentJob): string {
	const elapsedMs = (job.finishedAt ?? Date.now()) - job.startedAt;
	return [
		`subagent job: ${job.id}`,
		`status: ${job.status}`,
		`profile: ${job.profile.name}`,
		`description: ${job.description}`,
		`elapsed: ${elapsedMs}ms`,
		job.result?.text,
		job.error ? `error: ${job.error}` : "",
	].filter(Boolean).join("\n\n");
}

function jobDetails(job: SubagentJob): SubagentJobDetails {
	return {
		jobId: job.id,
		status: job.status,
		description: job.description,
		agent: job.profile.name,
		profilePath: job.profile.path,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		exitCode: job.result?.exitCode,
		metrics: job.result?.metrics,
		stderr: job.result?.stderr,
		error: job.error,
	};
}

function jobSummary(details: SubagentJobDetails, theme: Theme): string {
	const icon = details.status === "completed" ? "✓" : details.status === "running" ? "◌" : "✗";
	const color = details.status === "completed" ? "success" : details.status === "running" ? "warning" : "error";
	const elapsedMs = (details.finishedAt ?? Date.now()) - details.startedAt;
	const elapsed = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;
	const metrics = details.metrics ? ` · tools ${details.metrics.toolCompleted}/${details.metrics.toolCalls}` : "";
	return theme.fg(color, `${icon} job ${details.jobId} ${details.status}`)
		+ theme.fg("muted", ` · ${details.agent} · ${elapsed}${metrics}`);
}

function renderJobResult(
	result: { content: unknown; details?: SubagentJobDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): Text {
	const output = textFromContent(result.content);
	if (options.isPartial) return new Text(theme.fg("warning", output || "Working…"), 0, 0);
	if (options.expanded) return new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
	if (result.details) {
		return new Text(`${jobSummary(result.details, theme)} ${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`, 0, 0);
	}
	const firstLine = output.split("\n").find((line) => line.trim()) ?? "";
	return new Text(`${theme.fg(isError ? "error" : "toolOutput", firstLine)} ${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`, 0, 0);
}

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, SubagentJob>();
	let shuttingDown = false;

	const pruneCompletedJobs = (): void => {
		const completed = [...jobs.values()]
			.filter((job) => job.status !== "running")
			.sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
		while (jobs.size >= MAX_RETAINED_JOBS && completed.length > 0) {
			jobs.delete(completed.shift()!.id);
		}
	};

	const startJob = (params: SubagentRunParams, signal: AbortSignal | undefined, ctx: ExtensionContext): SubagentJob => {
		if (shuttingDown) throw new Error("Cannot start a subagent while the session is shutting down.");
		if (signal?.aborted) throw new Error("Subagent start aborted.");
		const activeJobs = [...jobs.values()].filter((job) => job.status === "running").length;
		if (activeJobs >= MAX_ACTIVE_JOBS) throw new Error(`Subagent concurrency limit reached (${MAX_ACTIVE_JOBS}). Collect or cancel an existing job first.`);
		pruneCompletedJobs();
		if (jobs.size >= MAX_RETAINED_JOBS) throw new Error(`Subagent job limit reached (${MAX_RETAINED_JOBS}).`);

		const prepared = prepareSubagent(params, ctx);
		let id = randomUUID().slice(0, 8);
		while (jobs.has(id)) id = randomUUID().slice(0, 8);
		const controller = new AbortController();
		const statusKey = `subagent-${id}`;
		const job: SubagentJob = {
			id,
			description: params.description,
			profile: prepared.profile,
			status: "running",
			startedAt: Date.now(),
			controller,
			promise: Promise.resolve(),
		};
		jobs.set(id, job);

		const abort = (): void => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		job.promise = runSubagent(params, ctx, {
			signal: controller.signal,
			onProgress: (message) => {
				if (ctx.hasUI && !shuttingDown) ctx.ui.setStatus(statusKey, `job ${id}: ${message}`);
			},
			onTimeout: async (elapsedSeconds, outputChars, metrics) => {
				if (!ctx.hasUI || shuttingDown) return true;
				const kill = await ctx.ui.confirm(
					"Subagent timeout",
					`Job ${id} (${params.agent ?? "general"}) has run for ${elapsedSeconds}s. ${metricsText(metrics)}. Output: ${outputChars} chars. Kill it now? Choose no to allow another timeout window.`,
					{ signal: controller.signal },
				);
				return controller.signal.aborted || kill;
			},
		}, prepared).then((result) => {
			job.result = result;
			job.status = result.exitCode === 0 ? "completed" : controller.signal.aborted ? "cancelled" : "failed";
		}).catch((error) => {
			job.error = error instanceof Error ? error.message : String(error);
			job.status = controller.signal.aborted ? "cancelled" : "failed";
		}).finally(() => {
			job.finishedAt = Date.now();
			signal?.removeEventListener("abort", abort);
			if (ctx.hasUI && !shuttingDown) ctx.ui.setStatus(statusKey, undefined);
			if (ctx.hasUI && !shuttingDown) {
				ctx.ui.notify(`Subagent job ${id} ${job.status}: ${job.description}`, job.status === "completed" ? "info" : "warning");
			}
		});
		return job;
	};

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const job of jobs.values()) {
			if (job.status === "running") job.controller.abort();
		}
		await Promise.allSettled([...jobs.values()].map((job) => job.promise));
		jobs.clear();
	});

	pi.registerMessageRenderer("subagent-result", (message, { expanded, outputPad }, theme) => {
		const output = textFromContent(message.content);
		if (expanded) return new Text(theme.fg("customMessageText", output), outputPad, 0);
		const details = message.details as { agent?: string; exitCode?: number | null; metrics?: SubagentMetrics } | undefined;
		const failed = details?.exitCode !== undefined && details.exitCode !== 0;
		const label = details?.agent ? `subagent ${details.agent}` : "subagent";
		const duration = details?.metrics?.durationMs ? ` · ${(details.metrics.durationMs / 1000).toFixed(1)}s` : "";
		const summary = theme.fg(failed ? "error" : "success", `${failed ? "✗" : "✓"} ${label}${failed ? " failed" : " completed"}`)
			+ theme.fg("muted", duration)
			+ ` ${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`;
		return new Text(summary, outputPad, 0);
	});

	pi.registerCommand("subagents", {
		description: "List, validate, or run local subagent profiles",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const agents = loadAgents(ctx.cwd, ctx.isProjectTrusted());

			if (args === "doctor") {
				const warnings = Object.values(agents).flatMap(profileWarnings);
				ctx.ui.notify(warnings.length ? `Subagent profile warnings:\n${warnings.join("\n")}` : "Subagent profiles OK", warnings.length ? "warning" : "info");
				return;
			}

			if (args === "jobs") {
				const lines = [...jobs.values()].map((job) => `- ${job.id}: ${job.status}, ${job.profile.name}, ${job.description}`);
				ctx.ui.notify(lines.length ? `Subagent jobs:\n${lines.join("\n")}` : "No subagent jobs", "info");
				return;
			}

			if (args.startsWith("run ")) {
				const [, agentName, ...taskParts] = args.split(/\s+/);
				const task = taskParts.join(" ").trim();
				if (!agentName || !task) {
					ctx.ui.notify("Usage: /subagents run <profile> <task>", "error");
					return;
				}
				ctx.ui.notify(`Running ${agentName} subagent: ${task}`, "info");
				try {
					const result = await runSubagent({ agent: agentName, description: task, prompt: task }, ctx, {
						onProgress: (message) => ctx.ui.setStatus("subagent", message),
						onTimeout: async (elapsedSeconds, outputChars, metrics) => ctx.ui.confirm(
							"Subagent timeout",
							`${agentName} subagent has run for ${elapsedSeconds}s. ${metricsText(metrics)}. Output: ${outputChars} chars. Kill it now? Choose no to allow another timeout window.`,
						),
					});
					pi.sendMessage({
						customType: "subagent-result",
						content: result.text,
						display: true,
						details: { agent: result.profile.name, profilePath: result.profile.path, exitCode: result.exitCode, metrics: result.metrics, stderr: result.stderr },
					});
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} finally {
					ctx.ui.setStatus("subagent", undefined);
				}
				return;
			}

			const lines = Object.values(agents).map(formatAgentLine);
			ctx.ui.notify(`Subagents:\n${lines.join("\n")}\n\nCommands:\n- /subagents doctor\n- /subagents jobs\n- /subagents run <profile> <task>`, "info");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent",
		description: "Start a focused Pi subagent as a background job and return its job ID immediately. Use subagent_result to collect the final report.",
		executionMode: "parallel",
		promptSnippet: "Start focused research, review, or implementation work in a background Pi process; collect it later with subagent_result.",
		promptGuidelines: [
			"Use subagent for independent, bounded work that benefits from a separate context, especially read-only research or review.",
			"A subagent call starts a background job and returns immediately. Continue useful independent work, then call subagent_result with its job ID before relying on its findings or finishing the task.",
			"Use the scout profile for fast codebase evidence, the review profile for correctness blockers, and the librarian profile for versioned dependency or API research.",
			"Start multiple independent read-only subagents early when parallel evidence is useful, then collect and merge their findings before editing.",
			"Do not run multiple implementation subagents against the same files unless the user explicitly asks for concurrent edits.",
			"Do not use subagent for trivial questions or when direct local tools are enough.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent profile name. Profiles include general, research, review, implementation, scout, and librarian. Add markdown profiles under ~/.pi/agent/subagents/*.md or .pi/subagents/*.md." })),
			description: Type.String({ description: "Short task title for the subagent." }),
			prompt: Type.String({ description: "Complete delegated task instructions." }),
			tools: Type.Optional(Type.String({ description: "Optional comma-separated Pi tools selection for profiles that do not fix their own tools, for example read,grep,find,ls." })),
			model: Type.Optional(Type.String({ description: "Optional Pi model selector, for example openai/gpt-5.5 or sonnet:high." })),
			thinking: Type.Optional(Type.String({ description: "Optional thinking level: off, minimal, low, medium, high, xhigh." })),
			timeout_seconds: Type.Optional(Type.Number({ description: "Timeout review window in seconds. Defaults to profile timeout or 1800. In interactive mode, Pi asks before killing it." })),
		}),
		renderCall(args, theme, context) {
			let text = theme.fg("toolTitle", theme.bold("subagent "))
				+ theme.fg("accent", args.agent ?? "general")
				+ theme.fg("muted", ` · ${args.description}`);
			if (context.expanded) {
				const options = [args.model, args.thinking, args.tools, args.timeout_seconds ? `${args.timeout_seconds}s` : undefined].filter(Boolean).join(" · ");
				if (options) text += `\n${theme.fg("dim", options)}`;
				text += `\n${theme.fg("toolOutput", args.prompt)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme, context) {
			return renderJobResult({ content: result.content, details: result.details as SubagentJobDetails | undefined }, options, theme, context.isError);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Starting ${params.agent ?? "general"} subagent: ${params.description}` }] });
			const job = startJob(params, signal, ctx);
			const text = [
				`subagent job: ${job.id}`,
				"status: running",
				`profile: ${job.profile.name}`,
				`description: ${job.description}`,
				"The job is running in the background. Continue independent work, then call subagent_result with this job ID before relying on its findings or finishing.",
			].join("\n\n");
			return { content: [{ type: "text", text }], details: jobDetails(job) };
		},
	});

	pi.registerTool({
		name: RESULT_TOOL_NAME,
		label: "Subagent Result",
		description: "Check, wait for, cancel, or collect a background subagent job.",
		executionMode: "parallel",
		promptSnippet: "Check or collect a background subagent job by ID.",
		parameters: Type.Object({
			job_id: Type.String({ description: "Job ID returned by subagent." }),
			wait: Type.Optional(Type.Boolean({ description: "Wait for completion when still running. Defaults to true; set false for a non-blocking status check." })),
			cancel: Type.Optional(Type.Boolean({ description: "Cancel the job before returning its status." })),
		}),
		renderCall(args, theme, context) {
			let text = theme.fg("toolTitle", theme.bold("subagent_result ")) + theme.fg("accent", args.job_id);
			if (context.expanded) {
				text += theme.fg("dim", ` · wait ${args.wait ?? true}${args.cancel ? " · cancel" : ""}`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme, context) {
			return renderJobResult({ content: result.content, details: result.details as SubagentJobDetails | undefined }, options, theme, context.isError);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			const job = jobs.get(params.job_id);
			if (!job) throw new Error(`Unknown subagent job '${params.job_id}'. Run /subagents jobs to list retained jobs.`);
			if (params.cancel && job.status === "running") job.controller.abort();
			if ((params.wait ?? true) && job.status === "running") {
				onUpdate?.({ content: [{ type: "text", text: `Waiting for subagent job ${job.id}: ${job.description}` }] });
				const abort = (): void => job.controller.abort();
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
				try {
					await job.promise;
				} finally {
					signal?.removeEventListener("abort", abort);
				}
			}
			const text = jobText(job);
			if (job.status === "failed" || job.status === "cancelled") throw new Error(text);
			return { content: [{ type: "text", text }], details: jobDetails(job) };
		},
	});
}

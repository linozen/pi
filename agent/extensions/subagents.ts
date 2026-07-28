import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const TOOL_NAME = "subagent";
const OUTPUT_LIMIT = 60_000;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const PROGRESS_INTERVAL_MS = 15_000;

const BUILTIN_AGENTS: Record<string, AgentProfile> = {
	general: {
		name: "general",
		description: "General-purpose subagent with the normal Pi toolset.",
		instructions: "You are a focused subagent. Complete the delegated task independently, then return a concise report with findings, changed files, verification, and open risks.",
	},
	research: {
		name: "research",
		description: "Read-only research subagent for codebase exploration and fact-finding.",
		tools: "read,grep,find,ls",
		instructions: "You are a read-only research subagent. Do not modify files. Return concrete findings with file paths and line references where possible.",
	},
	review: {
		name: "review",
		description: "Read-only review subagent for bugs, regressions, and simplification opportunities.",
		tools: "read,grep,find,ls",
		instructions: "You are a read-only code review subagent. Do not modify files. Rank findings by impact and include exact file paths.",
	},
	implementation: {
		name: "implementation",
		description: "Implementation subagent with the normal Pi toolset.",
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
	noSession?: boolean;
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
	no_session?: boolean;
};

type SubagentRunResult = {
	profile: AgentProfile;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	metrics: SubagentMetrics;
	text: string;
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
		noSession: parseBoolean(metadata(text, "no_session")),
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
	return `tools ${metrics.toolCompleted}/${metrics.toolCalls}${metrics.activeTools ? ` (${metrics.activeTools} active)` : ""}, tokens ${tokens} (in ${metrics.inputTokens}, out ${metrics.outputTokens}, cache ${metrics.cacheReadTokens}/${metrics.cacheWriteTokens})${cost}`;
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
		const child = spawn("pi", args, {
			cwd,
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutTail = "";
		let stdoutLineBuffer = "";
		let finalAssistantText = "";
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
		const startedAt = Date.now();
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
			const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
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
			const elapsedSeconds = Math.round((now - startedAt) / 1000);
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
					const update = updateMetricsFromEvent(event, metrics);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						const messageText = textFromContent(event.message.content).trim();
						if (messageText) finalAssistantText = trimOutput(messageText);
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
			clearInterval(progress);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			resolve({ exitCode: killedForTimeout || aborted ? -1 : exitCode, stdout: trimOutput(finalAssistantText || stdoutTail), stderr: stderrTail, metrics });
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

function buildRunArgs(profile: AgentProfile, params: SubagentRunParams, trusted: boolean, inheritedModel?: string): { args: string[]; timeoutMs: number } {
	const requestedTimeout = params.timeout_seconds ?? profile.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const timeoutSeconds = Number.isFinite(requestedTimeout) ? Math.max(1, requestedTimeout) : DEFAULT_TIMEOUT_SECONDS;
	const args = [
		"--mode",
		"json",
		"--name",
		`subagent: ${params.description}`,
		"--exclude-tools",
		TOOL_NAME,
		"--append-system-prompt",
		buildReportPrompt(profile),
	];

	if (trusted) args.push("--approve");
	if (params.no_session ?? profile.noSession) args.push("--no-session");
	const tools = profile.tools ?? params.tools;
	if (tools) args.push("--tools", tools);
	const model = params.model ?? profile.model ?? inheritedModel;
	if (model) args.push("--model", model);
	const thinking = params.thinking ?? profile.thinking;
	if (thinking) args.push("--thinking", thinking);
	args.push([`Task: ${params.description}`, params.prompt].join("\n\n"));

	return { args, timeoutMs: timeoutSeconds * 1000 };
}

async function runSubagent(params: SubagentRunParams, ctx: ExtensionContext | ExtensionCommandContext, options: RunPiOptions = {}): Promise<SubagentRunResult> {
	const agents = loadAgents(ctx.cwd, ctx.isProjectTrusted());
	const requestedProfile = params.agent ?? "general";
	const profile = agents[requestedProfile];
	if (!profile) throw new Error(`Unknown subagent profile '${requestedProfile}'. Run /subagents to list available profiles.`);
	const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const { args, timeoutMs } = buildRunArgs(profile, params, ctx.isProjectTrusted(), inheritedModel);
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
		agent.model ? `model: ${agent.model}` : undefined,
		agent.thinking ? `thinking: ${agent.thinking}` : undefined,
		agent.timeoutSeconds ? `timeout: ${agent.timeoutSeconds}s` : undefined,
		agent.noSession ? "no-session" : undefined,
	].filter(Boolean).join(", ");
	return `- ${agent.name}: ${agent.description}${defaults ? ` [${defaults}]` : ""}${agent.path ? ` (${agent.path})` : ""}`;
}

function profileWarnings(agent: AgentProfile): string[] {
	const warnings: string[] = [];
	if (agent.thinking && !/^(off|minimal|low|medium|high|xhigh)$/.test(agent.thinking)) warnings.push(`${agent.name}: unknown thinking level '${agent.thinking}'`);
	if (agent.timeoutSeconds !== undefined && (!Number.isFinite(agent.timeoutSeconds) || agent.timeoutSeconds <= 0)) warnings.push(`${agent.name}: timeout_seconds must be positive`);
	return warnings;
}

export default function (pi: ExtensionAPI) {
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
			ctx.ui.notify(`Subagents:\n${lines.join("\n")}\n\nCommands:\n- /subagents doctor\n- /subagents run <profile> <task>`, "info");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent",
		description: "Run a focused Pi subagent in a separate non-interactive Pi process and return its final output.",
		promptSnippet: "Delegate focused research, review, or implementation work to a separate Pi process.",
		promptGuidelines: [
			"Use subagent for independent, bounded work that benefits from a separate context, especially read-only research or review.",
			"Use the scout profile for fast codebase evidence, the review profile for correctness blockers, and the librarian profile for versioned dependency or API research.",
			"Prefer multiple read-only subagents for parallel audits, then merge their findings before editing.",
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
			timeout_seconds: Type.Optional(Type.Number({ description: "Timeout review window in seconds. Defaults to profile timeout or 1800. In interactive mode, Pi asks before killing a subagent that exceeds it." })),
			no_session: Type.Optional(Type.Boolean({ description: "Run the child Pi process with --no-session for throwaway work." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Running ${params.agent ?? "general"} subagent: ${params.description}` }] });
			const result = await runSubagent(params, ctx, {
				signal,
				onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }] }),
				onTimeout: async (elapsedSeconds, outputChars, metrics) => {
					if (!ctx.hasUI) return true;
					return ctx.ui.confirm(
						"Subagent timeout",
						`${params.agent ?? "general"} subagent has run for ${elapsedSeconds}s. ${metricsText(metrics)}. Output: ${outputChars} chars. Kill it now? Choose no to allow another timeout window.`,
					);
				},
			});
			if (result.exitCode !== 0) throw new Error(result.text);
			return {
				content: [{ type: "text", text: result.text }],
				details: { agent: result.profile.name, profilePath: result.profile.path, exitCode: result.exitCode, metrics: result.metrics, stderr: result.stderr },
			};
		},
	});
}

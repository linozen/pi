import { keyHint, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	LIVE_TRANSCRIPT_LIMIT,
	MAX_ACTIVE_JOBS,
	MAX_RETAINED_JOBS,
	MAX_REVIEWS_PER_REQUEST,
	MIN_HARD_TIMEOUT_SECONDS,
	PROGRESS_INTERVAL_MS,
	RESULT_TOOL_NAME,
	TOOL_NAME,
	type AgentProfile,
	applyChildEvent,
	buildJobDetailLines,
	buildJobRows,
	buildReason,
	buildResultText,
	buildRunArgs,
	emptyMetrics,
	formatAgentLine,
	isActiveStatus,
	jobText,
	loadAgents,
	metricsText,
	profileWarnings,
	resolveDefaultModel,
	statusStyle,
	subagentDedupeKey,
	textFromContent,
	timeoutDecisionText,
	trimOutput,
	type JobSnapshot,
	type RunControl,
	type SubagentJobStatus,
	type SubagentLive,
	type SubagentMetrics,
	type SubagentRunParams,
	type SubagentRunResult,
} from "./core.ts";

type PreparedSubagentRun = {
	profile: AgentProfile;
	args: string[];
	timeoutMs: number;
	model?: string;
};

type SubagentJob = JobSnapshot & {
	dedupeKey: string;
	controller: AbortController;
	control: RunControl;
	promise: Promise<void>;
};

type SubagentJobDetails = {
	jobId: string;
	status: SubagentJobStatus;
	description: string;
	agent: string;
	profilePath?: string;
	model?: string;
	windowSeconds: number;
	extensions: number;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	reason?: string;
	metrics?: SubagentMetrics;
	stderr?: string;
	error?: string;
};

type RunPiOptions = {
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	/** Window expiry asks the caller whether to kill; the child keeps running while the decision is pending. */
	onWindowExceeded?: (elapsedSeconds: number, outputChars: number, metrics: SubagentMetrics) => Promise<"kill" | "extend">;
	live?: SubagentLive;
	metrics?: SubagentMetrics;
	control?: RunControl;
};

type RunPiResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	metrics: SubagentMetrics;
	reason: string;
};

function appendStderrTo(tail: string, text: string): string {
	const next = tail + text;
	return next.length <= LIVE_TRANSCRIPT_LIMIT ? next : next.slice(-LIVE_TRANSCRIPT_LIMIT);
}

function runPi(args: string[], cwd: string, timeoutMs: number, options: RunPiOptions = {}): Promise<RunPiResult> {
	return new Promise((resolve) => {
		const startedAt = performance.now();
		const child = spawn("pi", args, {
			cwd,
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const metrics = options.metrics ?? emptyMetrics();
		const live = options.live;
		const timeoutSeconds = Math.round(timeoutMs / 1000);
		const hardTimeoutMs = Math.max(MIN_HARD_TIMEOUT_SECONDS * 1000, timeoutMs * 3);
		const hardTimeoutSeconds = Math.round(hardTimeoutMs / 1000);
		const timeoutStartedAt = Date.now();

		let stdoutTail = "";
		let stdoutLineBuffer = "";
		let finalAssistantText = "";
		let assistantFailure = "";
		let stderrTail = "";
		let outputChars = 0;
		let killedForTimeout = false;
		let hardKilled = false;
		let spawnError: string | undefined;
		let aborted = false;
		let settled = false;
		let awaitingTimeoutDecision = false;
		let deadline = Date.now() + timeoutMs;
		let windowTimer: ReturnType<typeof setTimeout> | undefined;
		let hardTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const appendStderr = (text: string): void => {
			stderrTail = appendStderrTo(stderrTail, text);
		};
		const clearTimers = (): void => {
			if (windowTimer) clearTimeout(windowTimer);
			if (hardTimer) clearTimeout(hardTimer);
			if (killTimer) clearTimeout(killTimer);
			windowTimer = undefined;
			hardTimer = undefined;
			killTimer = undefined;
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
		const scheduleWindowReview = (): void => {
			if (windowTimer) clearTimeout(windowTimer);
			windowTimer = setTimeout(() => void reviewWindow(), Math.max(1, deadline - Date.now()));
			windowTimer.unref();
		};
		const reviewWindow = async (): Promise<void> => {
			if (settled || awaitingTimeoutDecision) return;
			awaitingTimeoutDecision = true;
			const elapsedSeconds = Math.round((Date.now() - timeoutStartedAt) / 1000);
			let decision: "kill" | "extend" = "kill";
			try {
				decision = options.onWindowExceeded
					? await options.onWindowExceeded(elapsedSeconds, outputChars, metrics)
					: "kill";
			} catch (error) {
				appendStderr(`\nTimeout decision failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			awaitingTimeoutDecision = false;
			if (settled) return;
			if (decision === "kill") {
				killedForTimeout = true;
				appendStderr(`\nKilled after exceeding ${timeoutSeconds} second timeout window.`);
				terminate();
				return;
			}
			appendStderr(`\nContinuing after ${elapsedSeconds}s; next window review in ${timeoutSeconds}s, hard ceiling ${hardTimeoutSeconds}s.`);
			deadline = Date.now() + timeoutMs;
			scheduleWindowReview();
		};

		if (options.control) {
			options.control.extend = (seconds: number): void => {
				if (settled) return;
				deadline = Date.now() + Math.max(1, seconds) * 1000;
				scheduleWindowReview();
			};
		}

		options.onProgress?.(`subagent pid ${child.pid ?? "?"}: started, window review in ${timeoutSeconds}s, hard ceiling ${hardTimeoutSeconds}s`);
		const abort = () => {
			aborted = true;
			terminate();
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		scheduleWindowReview();
		hardTimer = setTimeout(() => {
			if (settled) return;
			hardKilled = true;
			appendStderr(`\nKilled after exceeding ${hardTimeoutSeconds}s hard timeout ceiling.`);
			terminate();
		}, hardTimeoutMs);
		hardTimer.unref();

		let lastOutputAt = Date.now();
		const progress = setInterval(() => {
			if (settled) return;
			const now = Date.now();
			const elapsedSeconds = Math.round((now - timeoutStartedAt) / 1000);
			const remainingSeconds = Math.max(0, Math.round((deadline - now) / 1000));
			const outputAgeSeconds = Math.round((now - lastOutputAt) / 1000);
			options.onProgress?.(`subagent pid ${child.pid ?? "?"}: running ${elapsedSeconds}s, ${remainingSeconds}s before window review, ${metricsText(metrics)}, output ${outputChars} chars, last output ${outputAgeSeconds}s ago`);
		}, PROGRESS_INTERVAL_MS);
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			outputChars += text.length;
			stdoutTail = (stdoutTail + text).slice(-LIVE_TRANSCRIPT_LIMIT);
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
						(event.type === "message_update" && event.assistantMessageEvent)
						|| (event.type === "message_end" && event.message?.role === "assistant")
						|| event.type === "tool_execution_start"
					)) metrics.firstOutputMs = elapsedMs;
					if (live) {
						const effect = applyChildEvent(event, metrics, live);
						if (effect && "assistantFailure" in effect) assistantFailure = effect.assistantFailure ?? "";
						if (effect?.progress) options.onProgress?.(`subagent pid ${child.pid ?? "?"}: ${effect.progress}; ${metricsText(metrics)}`);
					}
					if (event.type === "message_end" && event.message?.role === "assistant") {
						const messageText = textFromContent(event.message.content).trim();
						if (messageText) finalAssistantText = trimOutput(messageText);
					}
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
			// A failed spawn never emits close; settle here or the job hangs forever.
			if (!settled && child.pid === undefined) {
				settled = true;
				spawnError = error.message;
				clearInterval(progress);
				clearTimers();
				options.signal?.removeEventListener("abort", abort);
				resolve({
					exitCode: -1,
					stdout: "",
					stderr: stderrTail,
					metrics,
					reason: buildReason({ exitCode: -1, spawnError }),
				});
			}
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			metrics.durationMs = Math.round(performance.now() - startedAt);
			clearInterval(progress);
			clearTimers();
			options.signal?.removeEventListener("abort", abort);
			if (assistantFailure) appendStderr(`\n${assistantFailure}`);
			resolve({
				exitCode: killedForTimeout || hardKilled || aborted || assistantFailure ? -1 : exitCode,
				stdout: trimOutput(finalAssistantText || stdoutTail),
				stderr: stderrTail,
				metrics,
				reason: buildReason({
					exitCode,
					aborted,
					killedForTimeout,
					hardKilled,
					timeoutSeconds,
					hardTimeoutSeconds,
					assistantFailure: assistantFailure || undefined,
				}),
			});
		});
	});
}

function prepareSubagent(params: SubagentRunParams, ctx: ExtensionContext | ExtensionCommandContext): PreparedSubagentRun {
	const agents = loadAgents(ctx.cwd, ctx.isProjectTrusted());
	const requestedProfile = params.agent ?? "general";
	const profile = agents[requestedProfile];
	if (!profile) throw new Error(`Unknown subagent profile '${requestedProfile}'. Run /subagents to list available profiles.`);
	const { args, timeoutSeconds, model } = buildRunArgs(profile, params, ctx.isProjectTrusted(), resolveDefaultModel(profile.name, ctx.model));
	return { profile, args, timeoutMs: timeoutSeconds * 1000, model };
}

async function runSubagent(params: SubagentRunParams, ctx: ExtensionContext | ExtensionCommandContext, options: RunPiOptions = {}, prepared = prepareSubagent(params, ctx)): Promise<SubagentRunResult> {
	const { profile, args, timeoutMs } = prepared;
	const result = await runPi(args, ctx.cwd, timeoutMs, options);
	const text = buildResultText(profile, result);
	return { profile, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, metrics: result.metrics, reason: result.reason, text };
}

function jobDetails(job: SubagentJob): SubagentJobDetails {
	return {
		jobId: job.id,
		status: job.status,
		description: job.description,
		agent: job.profile.name,
		profilePath: job.profile.path,
		model: job.model,
		windowSeconds: job.windowSeconds,
		extensions: job.extensions,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		exitCode: job.result?.exitCode,
		reason: job.result?.reason,
		metrics: job.result?.metrics,
		stderr: job.result?.stderr,
		error: job.error,
	};
}

function jobSummary(details: SubagentJobDetails, theme: Theme): string {
	const { icon, color } = statusStyle(details.status);
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

const VIEW_LIST_ROWS = 16;
const VIEW_DETAIL_ROWS = 28;

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, SubagentJob>();
	let shuttingDown = false;
	let reviewsStartedThisRequest = 0;

	const pruneCompletedJobs = (): void => {
		const completed = [...jobs.values()]
			.filter((job) => !isActiveStatus(job.status))
			.sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
		while (jobs.size >= MAX_RETAINED_JOBS && completed.length > 0) {
			jobs.delete(completed.shift()!.id);
		}
	};

	const startJob = (params: SubagentRunParams, signal: AbortSignal | undefined, ctx: ExtensionContext): SubagentJob => {
		if (shuttingDown) throw new Error("Cannot start a subagent while the session is shutting down.");
		if (signal?.aborted) throw new Error("Subagent start aborted.");

		const prepared = prepareSubagent(params, ctx);
		const dedupeKey = subagentDedupeKey(prepared.profile, params.prompt);
		const duplicate = [...jobs.values()].find((job) => isActiveStatus(job.status) && job.dedupeKey === dedupeKey);
		if (duplicate) throw new Error(`Duplicate ${prepared.profile.name} subagent is already running as job ${duplicate.id}.`);

		const activeJobs = [...jobs.values()].filter((job) => isActiveStatus(job.status)).length;
		if (activeJobs >= MAX_ACTIVE_JOBS) throw new Error(`Subagent concurrency limit reached (${MAX_ACTIVE_JOBS}). Collect, cancel, or wait for an existing job first.`);
		pruneCompletedJobs();
		if (jobs.size >= MAX_RETAINED_JOBS) throw new Error(`Subagent job limit reached (${MAX_RETAINED_JOBS}).`);

		if (prepared.profile.name === "review") {
			if (reviewsStartedThisRequest >= MAX_REVIEWS_PER_REQUEST) throw new Error("Review budget exhausted for this user request. Verify confirmed findings directly instead of starting another review.");
			reviewsStartedThisRequest++;
		}
		let id = randomUUID().slice(0, 8);
		while (jobs.has(id)) id = randomUUID().slice(0, 8);
		const controller = new AbortController();
		const statusKey = `subagent-${id}`;
		const job: SubagentJob = {
			id,
			dedupeKey,
			description: params.description,
			prompt: params.prompt,
			profile: prepared.profile,
			model: prepared.model,
			windowSeconds: Math.round(prepared.timeoutMs / 1000),
			extensions: 0,
			status: "running",
			startedAt: Date.now(),
			metrics: emptyMetrics(),
			live: { transcript: "", streaming: "" },
			control: {},
			controller,
			promise: Promise.resolve(),
		};
		jobs.set(id, job);

		job.promise = runSubagent(params, ctx, {
			signal: controller.signal,
			live: job.live,
			metrics: job.metrics,
			control: job.control,
			onProgress: (message) => {
				if (ctx.hasUI && !shuttingDown) ctx.ui.setStatus(statusKey, `job ${id}: ${message}`);
			},
			onWindowExceeded: async (elapsedSeconds) => {
				if (job.status === "running") {
					job.status = "timed_out";
					job.extensions++;
					if (ctx.hasUI && !shuttingDown) ctx.ui.notify(`Subagent job ${id} exceeded its ${job.windowSeconds}s window and is still running: ${job.description}`, "warning");
					if (!shuttingDown) {
						pi.sendMessage({
							customType: "subagent-timeout",
							content: timeoutDecisionText(job, elapsedSeconds),
							display: true,
							details: jobDetails(job),
						}, { triggerTurn: true, deliverAs: "followUp" });
					}
				}
				return "extend";
			},
		}, prepared).then((result) => {
			job.result = result;
			job.status = result.exitCode === 0 ? "completed" : controller.signal.aborted ? "cancelled" : "failed";
		}).catch((error) => {
			job.error = error instanceof Error ? error.message : String(error);
			job.status = controller.signal.aborted ? "cancelled" : "failed";
		}).finally(() => {
			job.finishedAt = Date.now();
			if (ctx.hasUI && !shuttingDown) ctx.ui.setStatus(statusKey, undefined);
			if (ctx.hasUI && !shuttingDown) {
				ctx.ui.notify(`Subagent job ${id} ${job.status}: ${job.description}`, job.status === "completed" ? "info" : "warning");
			}
		});
		return job;
	};

	const showJobsView = async (ctx: ExtensionContext | ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("The subagent jobs view requires interactive TUI mode. Use /subagents jobs for a plain list.", "warning");
			return;
		}
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			let cursor = 0;
			let detailId: string | null = null;
			let scroll = 0;
			// shortcut: 1 Hz full re-render instead of invalidation bookkeeping; job state is small.
			const timer = setInterval(() => tui.requestRender(), 1000);

			const component = {
				render(width: number): string[] {
					if (width <= 0) return [""];
					if (detailId) {
						const job = jobs.get(detailId);
						if (!job) {
							detailId = null;
						} else {
							const wrapped: string[] = [];
							for (const line of buildJobDetailLines(job)) {
								if (!line.text) {
									wrapped.push("");
									continue;
								}
								const colored = line.color ? theme.fg(line.color, line.text) : line.text;
								wrapped.push(...wrapTextWithAnsi(colored, Math.max(1, width)).slice(0, 6));
							}
							scroll = Math.max(0, Math.min(scroll, Math.max(0, wrapped.length - VIEW_DETAIL_ROWS)));
							const lines = [
								theme.fg("accent", theme.bold(`Subagent job ${job.id}`)) + theme.fg("dim", " · up/down scroll · e extend window · c cancel · esc back"),
								"",
							];
							lines.push(...wrapped.slice(scroll, scroll + VIEW_DETAIL_ROWS));
							return lines;
						}
					}
					const rows = buildJobRows([...jobs.values()]);
					cursor = Math.min(cursor, Math.max(0, rows.length - 1));
					const lines = [
						theme.fg("accent", theme.bold("Subagent jobs")) + theme.fg("dim", ` · ${rows.length} retained · ${[...jobs.values()].filter((job) => isActiveStatus(job.status)).length} active`),
						"",
					];
					const offset = cursor < VIEW_LIST_ROWS ? 0 : cursor - VIEW_LIST_ROWS + 1;
					const visible = rows.slice(offset, offset + VIEW_LIST_ROWS);
					visible.forEach((row, index) => {
						const marker = offset + index === cursor ? theme.fg("accent", "› ") : "  ";
						lines.push(marker + truncateToWidth(theme.fg(row.color, `${row.icon} ${row.text}`), Math.max(1, width - 2)));
					});
					if (rows.length > offset + visible.length) lines.push(theme.fg("dim", `… ${rows.length - offset - visible.length} more`));
					lines.push("");
					lines.push(theme.fg("dim", "enter inspect · e extend window · c cancel · esc close"));
					return lines;
				},
				invalidate(): void {
					// Stateless render; nothing to clear.
				},
				handleInput(data: string): void {
					if (matchesKey(data, "escape")) {
						if (detailId) {
							detailId = null;
							scroll = 0;
						} else {
							done(undefined);
						}
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "up")) {
						if (detailId) scroll = Math.max(0, scroll - 3);
						else cursor = Math.max(0, cursor - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down")) {
						if (detailId) scroll += 3;
						else cursor = Math.min(Math.max(0, [...jobs.values()].length - 1), cursor + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageUp")) {
						if (detailId) scroll = Math.max(0, scroll - VIEW_DETAIL_ROWS);
						else cursor = Math.max(0, cursor - 8);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageDown")) {
						if (detailId) scroll += VIEW_DETAIL_ROWS;
						else cursor += 8;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "enter") && !detailId) {
						const rows = buildJobRows([...jobs.values()]);
						const row = rows[cursor];
						if (row) {
							detailId = row.id;
							scroll = 0;
						}
						tui.requestRender();
						return;
					}
					const rows = buildJobRows([...jobs.values()]);
					const target = detailId ?? rows[cursor]?.id;
					const job = target ? jobs.get(target) : undefined;
					if (matchesKey(data, "c")) {
						if (job && isActiveStatus(job.status)) {
							job.controller.abort();
							ctx.ui.notify(`Cancelled subagent job ${job.id}: ${job.description}`, "warning");
						}
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "e")) {
						if (job && isActiveStatus(job.status)) {
							const seconds = Math.max(60, job.windowSeconds);
							job.control.extend?.(seconds);
							if (job.status === "timed_out") job.status = "running";
							ctx.ui.notify(`Extended subagent job ${job.id} window by ${seconds}s`, "info");
						}
						tui.requestRender();
						return;
					}
				},
				dispose(): void {
					clearInterval(timer);
				},
			};
			return component;
		});
	};

	pi.on("before_agent_start", () => {
		reviewsStartedThisRequest = 0;
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const job of jobs.values()) {
			if (isActiveStatus(job.status)) job.controller.abort();
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

	pi.registerMessageRenderer("subagent-timeout", (message, { expanded, outputPad }, theme) => {
		const output = textFromContent(message.content);
		if (expanded) return new Text(theme.fg("warning", output), outputPad, 0);
		const details = message.details as { jobId?: string; agent?: string; windowSeconds?: number } | undefined;
		const label = details?.jobId ? `job ${details.jobId}` : "job";
		const agent = details?.agent ? ` (${details.agent})` : "";
		const summary = theme.fg("warning", `◷ subagent ${label}${agent} exceeded its ${details?.windowSeconds ?? "?"}s window — still running, decide via ${RESULT_TOOL_NAME}`)
			+ ` ${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`;
		return new Text(summary, outputPad, 0);
	});

	pi.registerCommand("subagents", {
		description: "List, validate, inspect, or run local subagent profiles",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const agents = loadAgents(ctx.cwd, ctx.isProjectTrusted());

			if (args === "doctor") {
				const warnings = Object.values(agents).flatMap(profileWarnings);
				ctx.ui.notify(warnings.length ? `Subagent profile warnings:\n${warnings.join("\n")}` : "Subagent profiles OK", warnings.length ? "warning" : "info");
				return;
			}

			if (args === "jobs") {
				const rows = buildJobRows([...jobs.values()]);
				ctx.ui.notify(rows.length ? `Subagent jobs:\n${rows.map((row) => `- ${row.icon} ${row.text}`).join("\n")}` : "No subagent jobs", "info");
				return;
			}

			if (args === "view") {
				await showJobsView(ctx);
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
						onWindowExceeded: async (elapsedSeconds, outputChars, metrics) => (await ctx.ui.confirm(
							"Subagent timeout",
							`${agentName} subagent has run for ${elapsedSeconds}s. ${metricsText(metrics)}. Output: ${outputChars} chars. Kill it now? Choose No to let it continue; the window is reviewed again after another timeout period.`,
						)) ? "kill" : "extend",
					});
					pi.sendMessage({
						customType: "subagent-result",
						content: result.text,
						display: true,
						details: { agent: result.profile.name, profilePath: result.profile.path, exitCode: result.exitCode, reason: result.reason, metrics: result.metrics, stderr: result.stderr },
					});
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} finally {
					ctx.ui.setStatus("subagent", undefined);
				}
				return;
			}

			const lines = Object.values(agents).map((agent) => formatAgentLine(agent, resolveDefaultModel(agent.name, ctx.model)));
			ctx.ui.notify([
				`Subagents:`,
				...lines,
				"",
				"Commands:",
				"- /subagents jobs — list retained jobs",
				"- /subagents view — live jobs view (also ctrl+shift+j)",
				"- /subagents run <profile> <task>",
				"- /subagents doctor",
			].join("\n"), "info");
		},
	});

	// ctrl+shift+j avoids AeroSpace's alt+j and Herdr's ctrl+b prefix.
	pi.registerShortcut(Key.ctrlShift("j"), {
		description: "Show subagent jobs",
		handler: async (ctx) => {
			await showJobsView(ctx);
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent",
		description: "Start a bounded Pi subagent as a background job when separate context materially helps, and return its job ID immediately. Jobs are not killed on timeout: when the window expires the job keeps running and you are asked to decide whether to extend or cancel it.",
		executionMode: "parallel",
		promptSnippet: "Start a bounded background subagent only when separate context materially helps.",
		promptGuidelines: [
			"Prefer direct inspection and verification; do not use subagent for work the parent can complete with a few local tool calls.",
			"Use the scout profile for fast codebase evidence, the review profile only for an independent correctness check, and the librarian profile for versioned dependency or API research.",
			"At most two review subagents are permitted per user request. Never ask a reviewer to review fixes made in response to an earlier review; run targeted verification instead.",
			"Treat subagent findings as evidence, not required work. Confirm a finding before changing code, and do not implement style, speculative hardening, or optional refactors during a correctness task.",
			"Start multiple read-only subagents only when their scopes are independent and parallel evidence will materially reduce latency.",
			"Collect a subagent result only when its answer is necessary for the requested outcome; cancel optional jobs rather than delaying completion.",
			"When a job exceeds its timeout window it is not killed. Decide promptly when asked: extend with subagent_result extend_seconds if the job was making progress, or cancel it. Do not restart the same task while its job is still running.",
			"Do not run multiple implementation subagents against the same files unless the user explicitly asks for concurrent edits.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent profile name. Profiles include general, research, review, implementation, scout, and librarian. Add markdown profiles under ~/.pi/agent/subagents/*.md or .pi/subagents/*.md." })),
			description: Type.String({ description: "Short task title for the subagent." }),
			prompt: Type.String({ description: "Complete delegated task instructions." }),
			tools: Type.Optional(Type.String({ description: "Optional comma-separated Pi tools selection for profiles that do not fix their own tools, for example read,grep,find,ls." })),
			model: Type.Optional(Type.String({ description: "Optional Pi model selector, for example openrouter/deepseek/deepseek-v4-flash or sonnet:high. Defaults to the per-provider default for the current session." })),
			thinking: Type.Optional(Type.String({ description: "Optional thinking level: off, minimal, low, medium, high, xhigh." })),
			timeout_seconds: Type.Optional(Type.Number({ description: "Timeout window in seconds. Defaults to the profile timeout or 300; review jobs are capped at 300. On expiry the job keeps running and you decide; a hard ceiling of max(1800s, 3x window) always applies." })),
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
			onUpdate?.({ content: [{ type: "text", text: `Starting ${params.agent ?? "general"} subagent: ${params.description}` }], details: undefined });
			const job = startJob(params, signal, ctx);
			const text = [
				`subagent job: ${job.id}`,
				"status: running",
				`profile: ${job.profile.name}`,
				`model: ${job.model ?? "session default"}`,
				`description: ${job.description}`,
				`timeout window: ${job.windowSeconds}s (expiry asks you to decide, it does not kill)`,
				"The job is running in the background. Continue independent work. Collect it only if its result is necessary; otherwise cancel it rather than delaying completion.",
			].join("\n\n");
			return { content: [{ type: "text", text }], details: jobDetails(job) };
		},
	});

	pi.registerTool({
		name: RESULT_TOOL_NAME,
		label: "Subagent Result",
		description: "Check, wait for, extend, cancel, or collect a background subagent job. Combined result text is truncated to 20,000 characters. A job that exceeded its timeout window has status timed_out and is still running: extend it with extend_seconds, cancel it, or leave it running and collect later.",
		executionMode: "parallel",
		promptSnippet: "Check, extend, cancel, or collect a background subagent job by ID.",
		parameters: Type.Object({
			job_id: Type.String({ description: "Job ID returned by subagent." }),
			wait: Type.Optional(Type.Boolean({ description: "Wait for completion when still running. Defaults to true; set false for a non-blocking status check. A timed_out job returns immediately with a decision request instead of waiting." })),
			cancel: Type.Optional(Type.Boolean({ description: "Cancel the job before returning its status." })),
			extend_seconds: Type.Optional(Type.Number({ description: "Grant the job another timeout window of this many seconds. Applies to running and timed_out jobs; the hard ceiling still applies." })),
		}),
		renderCall(args, theme, context) {
			let text = theme.fg("toolTitle", theme.bold("subagent_result ")) + theme.fg("accent", args.job_id);
			if (context.expanded) {
				const options = [
					`wait ${args.wait ?? true}`,
					args.cancel ? "cancel" : undefined,
					args.extend_seconds ? `extend ${args.extend_seconds}s` : undefined,
				].filter(Boolean).join(" · ");
				text += theme.fg("dim", ` · ${options}`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme, context) {
			return renderJobResult({ content: result.content, details: result.details as SubagentJobDetails | undefined }, options, theme, context.isError);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			const job = jobs.get(params.job_id);
			if (!job) throw new Error(`Unknown subagent job '${params.job_id}'. Run /subagents jobs to list retained jobs.`);
			if (params.extend_seconds !== undefined) {
				if (!isActiveStatus(job.status)) throw new Error(`Job ${job.id} already ${job.status}; extend_seconds applies only to running or timed_out jobs.`);
				const seconds = Math.max(1, Math.round(params.extend_seconds));
				job.control.extend?.(seconds);
				if (job.status === "timed_out") job.status = "running";
				job.windowSeconds = seconds;
			}
			if (params.cancel && isActiveStatus(job.status)) job.controller.abort();
			if ((params.wait ?? true) && job.status === "running" && !signal?.aborted) {
				onUpdate?.({ content: [{ type: "text", text: `Waiting for subagent job ${job.id}: ${job.description}` }], details: undefined });
				let abortWait: (() => void) | undefined;
				const waitAborted = new Promise<void>((resolve) => {
					abortWait = () => resolve();
					signal?.addEventListener("abort", abortWait, { once: true });
				});
				// Window expiry must unblock a pending wait so the parent can decide.
				let statusPoll: ReturnType<typeof setInterval> | undefined;
				const windowExpired = new Promise<void>((resolve) => {
					statusPoll = setInterval(() => {
						if (job.status !== "running") resolve();
					}, 500);
					statusPoll?.unref?.();
				});
				try {
					await Promise.race([job.promise, waitAborted, windowExpired]);
				} finally {
					if (abortWait) signal?.removeEventListener("abort", abortWait);
					if (statusPoll) clearInterval(statusPoll);
				}
			}
			const text = jobText(job);
			if (job.status === "failed" || job.status === "cancelled") throw new Error(text);
			return { content: [{ type: "text", text }], details: jobDetails(job) };
		},
	});
}

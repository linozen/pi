import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	MAX_REVIEW_TIMEOUT_SECONDS,
	applyChildEvent,
	argsSummary,
	buildJobDetailLines,
	buildJobRows,
	buildReason,
	buildResultText,
	buildRunArgs,
	emptyMetrics,
	isActiveStatus,
	jobText,
	metadata,
	parseAgentFile,
	parseBoolean,
	parseTimeout,
	sortJobs,
	statusStyle,
	resolveDefaultModel,
	subagentDedupeKey,
	timeoutDecisionText,
	trimOutput,
	type JobSnapshot,
	type SubagentLive,
} from "./core.ts";

const profile = {
	name: "scout",
	description: "test scout",
	instructions: "scout instructions",
	tools: "read,grep,find,ls",
	disableExtensions: true,
};

function snapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
	return {
		id: "abcd1234",
		description: "Inventory widgets",
		prompt: "Find every widget constructor call.",
		profile,
		model: "openrouter/deepseek/deepseek-v4-flash",
		windowSeconds: 300,
		extensions: 0,
		status: "running",
		startedAt: Date.now() - 90_000,
		metrics: emptyMetrics(),
		live: { transcript: "", streaming: "" },
		...overrides,
	};
}

test("resolveDefaultModel pairs profiles with providers and inherits for unknown providers", () => {
	// Provider-wide defaults (no per-profile override).
	assert.equal(resolveDefaultModel("general", { provider: "openai-codex", id: "gpt-5.6-sol" }), "openai-codex/gpt-6.1-sol");
	// Per-profile overrides.
	assert.equal(resolveDefaultModel("implementation", { provider: "openai-codex", id: "gpt-5.6-sol" }), "openai-codex/gpt-6-astra");
	assert.equal(resolveDefaultModel("scout", { provider: "openai-codex", id: "gpt-5.6-sol" }), "openai-codex/gpt-6-luna");
	// Other providers inherit the actual parent model instead of stale mappings.
	assert.equal(resolveDefaultModel("scout", { provider: "mistral", id: "model-x" }), "mistral/model-x");
	assert.equal(resolveDefaultModel("review", { provider: "openrouter", id: "model-y" }), "openrouter/model-y");
	// Unknown providers and missing session models.
	assert.equal(resolveDefaultModel("implementation", { provider: "anthropic", id: "claude-x" }), "anthropic/claude-x");
	assert.equal(resolveDefaultModel("implementation", undefined), undefined);
});

test("trimOutput keeps short values and marks truncation", () => {
	assert.equal(trimOutput("short"), "short");
	const truncated = trimOutput("x".repeat(50), 20);
	assert.ok(truncated.endsWith("[output truncated]"));
	assert.ok(truncated.length <= 20);
});

test("subagentDedupeKey normalizes whitespace and case", () => {
	assert.equal(
		subagentDedupeKey(profile, "Find  the\nWIDGETS"),
		subagentDedupeKey(profile, "find the widgets"),
	);
});

test("profile metadata parsing", () => {
	assert.equal(metadata("description: Fast scout\n", "description"), "Fast scout");
	assert.equal(parseBoolean("yes"), true);
	assert.equal(parseBoolean("nope"), undefined);
	assert.equal(parseTimeout("90"), 90);
	assert.equal(parseTimeout("0"), undefined);
});

test("parseAgentFile reads profile front matter", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-test-"));
	const path = join(dir, "probe.md");
	writeFileSync(path, "description: Probe things\ntools: read,ls\nthinking: low\ntimeout_seconds: 45\nno_extensions: true\n\n# Probe\n\nDo the probe.\n");
	const parsed = parseAgentFile(path);
	assert.ok(parsed);
	assert.equal(parsed.name, "probe");
	assert.equal(parsed.description, "Probe things");
	assert.equal(parsed.tools, "read,ls");
	assert.equal(parsed.thinking, "low");
	assert.equal(parsed.timeoutSeconds, 45);
	assert.equal(parsed.disableExtensions, true);
	assert.ok(parsed.instructions.includes("Do the probe."));
});

test("applyChildEvent folds tool events into metrics and live transcript", () => {
	const metrics = emptyMetrics();
	const live: SubagentLive = { transcript: "", streaming: "" };
	const start = applyChildEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "ls -la" } }, metrics, live);
	assert.equal(start?.progress, "tool started: bash");
	assert.equal(metrics.toolCalls, 1);
	assert.equal(metrics.activeTools, 1);
	assert.equal(live.lastTool, "bash {\"command\":\"ls -la\"}");
	assert.ok(live.transcript.includes("→ bash"));

	const end = applyChildEvent({ type: "tool_execution_end", toolName: "bash", isError: true }, metrics, live);
	assert.equal(end?.progress, "tool finished: bash (error)");
	assert.equal(metrics.toolErrors, 1);
	assert.ok(live.transcript.includes("← bash ✗"));
});

test("applyChildEvent accumulates usage and assistant text, reports failures", () => {
	const metrics = emptyMetrics();
	const live: SubagentLive = { transcript: "", streaming: "" };
	applyChildEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Work" } }, metrics, live);
	applyChildEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ing" } }, metrics, live);
	assert.equal(live.streaming, "Working");
	const ok = applyChildEvent(
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Working" }], usage: { input: 10, output: 5, cacheRead: 100, cost: { total: 0.01 } }, stopReason: "stop" } },
		metrics,
		live,
	);
	assert.equal(metrics.inputTokens, 10);
	assert.equal(metrics.cacheReadTokens, 100);
	assert.equal(metrics.cost, 0.01);
	assert.equal(live.streaming, "");
	assert.ok(live.transcript.includes("Working"));
	assert.equal(ok?.assistantFailure, null);

	const failed = applyChildEvent(
		{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider 500" } },
		metrics,
		live,
	);
	assert.equal(failed?.assistantFailure, "provider 500");
});

test("argsSummary collapses and truncates", () => {
	assert.equal(argsSummary({ command: "ls -la  cwd" }), '{"command":"ls -la cwd"}');
	assert.equal(argsSummary(undefined), "");
	const long = argsSummary({ command: "x".repeat(400) });
	assert.ok(long.length <= 161);
	assert.ok(long.endsWith("…"));
});

test("buildReason names the dominant failure cause", () => {
	assert.equal(buildReason({ exitCode: -1, spawnError: "ENOENT" }), "spawn failed: ENOENT");
	assert.equal(buildReason({ exitCode: -1, aborted: true }), "cancelled by parent or shutdown");
	assert.equal(buildReason({ exitCode: -1, hardKilled: true, hardTimeoutSeconds: 1800 }), "killed after exceeding 1800s hard timeout ceiling");
	assert.equal(buildReason({ exitCode: -1, killedForTimeout: true, timeoutSeconds: 300 }), "killed after exceeding 300s timeout window");
	assert.equal(buildReason({ exitCode: -1, assistantFailure: "provider 500" }), "assistant stopped: provider 500");
	assert.equal(buildReason({ exitCode: 0 }), "completed");
	assert.equal(buildReason({ exitCode: 3 }), "exited with code 3");
});

test("buildResultText puts reason and stderr before partial output", () => {
	const text = buildResultText(profile, {
		exitCode: -1,
		stdout: "PARTIAL OUTPUT THAT SHOULD COME LAST",
		stderr: "Killed after exceeding 300 second timeout window.",
		metrics: emptyMetrics(),
		reason: "killed after exceeding 300s timeout window",
	});
	const stderrIndex = text.indexOf("Killed after exceeding");
	const stdoutIndex = text.indexOf("PARTIAL OUTPUT");
	assert.ok(stderrIndex >= 0 && stdoutIndex > stderrIndex);
	assert.ok(text.indexOf("reason: killed after exceeding 300s timeout window") < stderrIndex);
});

test("buildRunArgs resolves defaults, caps review windows, and appends the prompt last", () => {
	const general = buildRunArgs(profile, { description: "Task", prompt: "Body" }, false, "openai-codex/gpt-5.6-luna");
	assert.ok(general.args.includes("--model"));
	assert.equal(general.model, "openai-codex/gpt-5.6-luna");
	assert.equal(general.timeoutSeconds, 300);
	assert.equal(general.args.at(-1), "Task: Task\n\nBody");

	const review = { ...profile, name: "review" };
	const capped = buildRunArgs(review, { description: "R", prompt: "P", timeout_seconds: 9999 }, false, undefined);
	assert.equal(capped.timeoutSeconds, MAX_REVIEW_TIMEOUT_SECONDS);

	const explicit = buildRunArgs(profile, { description: "D", prompt: "P", timeout_seconds: 45, model: "sonnet:high" }, true, "fallback-model");
	assert.equal(explicit.timeoutSeconds, 45);
	assert.equal(explicit.model, "sonnet:high");
	assert.ok(explicit.args.includes("--approve"));
});

test("timeout decision text gives the parent explicit choices", () => {
	const job = snapshot({ status: "timed_out", extensions: 1 });
	const text = timeoutDecisionText(job, 300);
	assert.ok(text.includes(job.id));
	assert.ok(text.includes("still running"));
	assert.ok(text.includes("extend_seconds"));
	assert.ok(text.includes("cancel=true"));
});

test("jobText for timed_out jobs asks for a decision instead of erroring", () => {
	const job = snapshot({ status: "timed_out", extensions: 1 });
	const text = jobText(job);
	assert.ok(text.includes("status: timed_out"));
	assert.ok(text.includes("not killed"));
	assert.ok(text.includes("extend_seconds"));
});

test("active-status handling: running and timed_out count, finished states do not", () => {
	assert.ok(isActiveStatus("running"));
	assert.ok(isActiveStatus("timed_out"));
	assert.ok(!isActiveStatus("completed"));
	assert.ok(!isActiveStatus("failed"));
	assert.ok(!isActiveStatus("cancelled"));
	assert.equal(statusStyle("timed_out").color, "warning");
});

test("job rows sort active jobs first and include the decision flag", () => {
	const rows = buildJobRows([
		snapshot({ id: "finished1", status: "completed", finishedAt: Date.now() }),
		snapshot({ id: "active1", status: "timed_out", extensions: 1 }),
		snapshot({ id: "active0", status: "running", startedAt: Date.now() }),
	]);
	assert.deepEqual(rows.map((row) => row.id), ["active0", "active1", "finished1"]);
	assert.ok(rows[1].text.includes("awaiting decision"));
	assert.ok(rows[1].active);
});

test("sortJobs is stable for finished jobs by recency", () => {
	const sorted = sortJobs([
		snapshot({ id: "old", status: "failed", finishedAt: 1_000 }),
		snapshot({ id: "new", status: "failed", finishedAt: 2_000 }),
	]);
	assert.deepEqual(sorted.map((job) => job.id), ["new", "old"]);
});

test("job detail lines include status, window, prompt head, and transcript", () => {
	const job = snapshot({
		status: "running",
		live: { transcript: "→ bash ls", streaming: "thinking aloud" },
		prompt: "line1\nline2\nline3",
	});
	const lines = buildJobDetailLines(job);
	const text = lines.map((line) => line.text).join("\n");
	assert.ok(text.includes("job abcd1234 — running"));
	assert.ok(text.includes("window 300s"));
	assert.ok(text.includes("line1"));
	assert.ok(text.includes("→ bash ls"));
	assert.ok(text.includes("thinking aloud"));
});

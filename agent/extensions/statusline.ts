// Custom one-line statusline. Includes cwd, extension statuses, token/context stats, model,
// thinking level, and ChatGPT Codex quota when available.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type QuotaWindow = {
	usedPercent: number;
	windowSeconds: number;
	resetAt?: number;
};

type UsageSnapshot = {
	planType?: string;
	email?: string;
	fiveHour?: QuotaWindow;
	weekly?: QuotaWindow;
	fetchedAt: number;
};

type State = {
	snapshot?: UsageSnapshot;
	inFlight?: Promise<UsageSnapshot | undefined>;
	queued?: Promise<UsageSnapshot | undefined>;
	requestRender: () => void;
};

const CHATGPT_BASE_URL = (process.env.CHATGPT_BASE_URL || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOpenAICodexProvider(provider: string | undefined): boolean {
	return provider === "openai-codex" || /^openai-codex-\d+$/.test(provider || "");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2 || !parts[1]) return {};

	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return {};
	}
}

function getTokenMetadata(token: string): { accountId?: string; planType?: string; email?: string } {
	const payload = decodeJwtPayload(token);
	const auth = isRecord(payload[OPENAI_AUTH_CLAIM]) ? payload[OPENAI_AUTH_CLAIM] : undefined;
	const profile = isRecord(payload[OPENAI_PROFILE_CLAIM]) ? payload[OPENAI_PROFILE_CLAIM] : undefined;

	return {
		accountId: typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
		planType: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
		email: typeof profile?.email === "string" ? profile.email : undefined,
	};
}

function normalizeWindow(value: unknown): QuotaWindow | undefined {
	if (!isRecord(value)) return undefined;

	const usedPercent = typeof value.used_percent === "number" ? value.used_percent : undefined;
	const windowSeconds = typeof value.limit_window_seconds === "number" ? value.limit_window_seconds : undefined;
	const resetAt = typeof value.reset_at === "number" ? value.reset_at : undefined;

	if (usedPercent === undefined || windowSeconds === undefined) return undefined;
	return { usedPercent, windowSeconds, resetAt };
}

function parseUsageSnapshot(data: unknown): UsageSnapshot {
	const raw = isRecord(data) ? data : {};
	const rateLimit = isRecord(raw.rate_limit) ? raw.rate_limit : {};
	const windows = [normalizeWindow(rateLimit.primary_window), normalizeWindow(rateLimit.secondary_window)].filter(
		(window): window is QuotaWindow => Boolean(window),
	);

	return {
		planType: typeof raw.plan_type === "string" ? raw.plan_type : undefined,
		email: typeof raw.email === "string" ? raw.email : undefined,
		fiveHour: windows.find((window) => Math.abs(window.windowSeconds - FIVE_HOUR_SECONDS) <= 120),
		weekly: windows.find((window) => Math.abs(window.windowSeconds - WEEK_SECONDS) <= 120),
		fetchedAt: Date.now(),
	};
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function usedPercent(window: QuotaWindow | undefined): string {
	if (!window) return "?%";
	return `${Math.round(Math.max(0, Math.min(100, window.usedPercent)))}%`;
}

function remainingPercent(window: QuotaWindow | undefined): string {
	if (!window) return "?%";
	return `${Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))}%`;
}

function resetLong(resetAt: number | undefined): string {
	if (!resetAt) return "unknown";

	const minutes = Math.max(0, Math.round((resetAt * 1000 - Date.now()) / 60000));
	const days = Math.floor(minutes / (60 * 24));
	const hours = Math.floor((minutes % (60 * 24)) / 60);
	const mins = minutes % 60;

	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${mins}m`;
	return `in ${mins}m`;
}

type FooterColor = "dim" | "muted" | "mdCode" | "success" | "warning" | "error";

function thinkingColor(level: string): FooterColor {
	if (level === "minimal") return "muted";
	if (level === "low") return "mdCode";
	if (level === "medium") return "success";
	if (level === "high") return "warning";
	if (level === "xhigh") return "error";
	return "dim";
}

function usageColor(percent: number | undefined | null): FooterColor {
	if (percent === undefined || percent === null || !Number.isFinite(percent)) return "dim";
	const clamped = Math.max(0, Math.min(100, percent));
	if (clamped < 25) return "mdCode";
	if (clamped < 50) return "success";
	if (clamped < 75) return "warning";
	return "error";
}

function formatChatGptLimit(ctx: ExtensionContext, snapshot: UsageSnapshot | undefined, theme: any): string | undefined {
	if (!isOpenAICodexProvider(ctx.model?.provider) || !snapshot) return undefined;

	const limits = [
		snapshot.fiveHour && `${theme.fg("dim", "5h ")}${theme.fg(usageColor(snapshot.fiveHour.usedPercent), usedPercent(snapshot.fiveHour))}`,
		snapshot.weekly && `${theme.fg("dim", "W ")}${theme.fg(usageColor(snapshot.weekly.usedPercent), usedPercent(snapshot.weekly))}`,
	].filter((limit): limit is string => Boolean(limit));
	return limits.length ? limits.join(theme.fg("dim", " / ")) : undefined;
}

const NONO_PROFILE_ENV_KEYS = ["NONO_PROFILE", "NONO_PROFILE_NAME", "NONO_PROFILE_ID"];

function getNonoProfileName(): string | undefined {
	for (const key of NONO_PROFILE_ENV_KEYS) {
		const value = process.env[key]?.trim();
		if (value) return value.split(/[\\/]/).pop()?.replace(/\.json$/i, "");
	}
	return undefined;
}

function formatExtensionStatus(rawText: unknown): string {
	const text = String(rawText).replace(/[\r\n\t]+/g, " ").trim();
	if (text === "nono sandbox") {
		const profile = getNonoProfileName();
		return profile ? `nono (${profile})` : text;
	}
	return text;
}

function extensionStatusText(footerData: any): string | undefined {
	const statuses = footerData.getExtensionStatuses?.();
	if (!statuses?.size) return undefined;
	return Array.from(statuses.entries())
		.sort(([a], [b]) => String(a).localeCompare(String(b)))
		.map(([, text]) => formatExtensionStatus(text))
		.filter(Boolean)
		.join(" ");
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const isUnderHome = cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`);
	return isUnderHome ? `~${cwd.slice(home.length)}` : cwd;
}

function renderOneLineFooter(pi: ExtensionAPI, ctx: ExtensionContext, state: State, footerData: any, width: number): string[] {
	const theme = ctx.ui.theme;
	const model = ctx.model;
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage: any = entry.message.usage || {};
			total.input += usage.input ?? 0;
			total.output += usage.output ?? 0;
			total.cacheRead += usage.cacheRead ?? 0;
			total.cacheWrite += usage.cacheWrite ?? 0;
			total.cost += usage.cost?.total ?? 0;
		}
	}

	const cwdPart = theme.fg("mdCode", formatCwd(ctx.sessionManager.getCwd()));
	const branch = footerData.getGitBranch?.();
	const branchPart = branch ? ` ${theme.fg("success", `(${branch})`)}` : "";
	const sessionName = ctx.sessionManager.getSessionName?.();
	const sessionPart = sessionName ? ` ${theme.fg("dim", `• ${sessionName}`)}` : "";
	const statusText = extensionStatusText(footerData);

	const dimStat = (text: string) => theme.fg("dim", text);
	const statsParts: string[] = [];
	if (total.input) statsParts.push(dimStat(`↑${formatTokens(total.input)}`));
	if (total.output) statsParts.push(dimStat(`↓${formatTokens(total.output)}`));
	if (total.cacheWrite) statsParts.push(dimStat(`W${formatTokens(total.cacheWrite)}`));

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const contextPercent = contextUsage?.percent;
	const contextDisplay = typeof contextPercent === "number"
		? `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`
		: `?/${formatTokens(contextWindow)}`;
	statsParts.push(`${theme.fg(usageColor(contextUsage?.percent), contextDisplay)} ${dimStat("(auto)")}`);

	const chatGptLimit = formatChatGptLimit(ctx, state.snapshot, theme);
	if (chatGptLimit) statsParts.push(chatGptLimit);

	let modelPart = theme.fg("dim", model?.id || "no-model");
	if (model?.reasoning) {
		const thinkingLevel = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "off";
		modelPart +=
			thinkingLevel === "off"
				? `${theme.fg("dim", " • ")}${theme.fg(thinkingColor(thinkingLevel), "thinking off")}`
				: `${theme.fg("dim", " • ")}${theme.fg(thinkingColor(thinkingLevel), thinkingLevel)}`;
	}

	const left = `${cwdPart}${branchPart}${sessionPart}${theme.fg("dim", " • ")}${statsParts.join(theme.fg("dim", " "))}`;
	let right = modelPart;
	if (footerData.getAvailableProviderCount?.() > 1 && model) {
		right = `${theme.fg("dim", `(${model.provider}) `)}${modelPart}`;
	}
	if (statusText) {
		right = `${right}${theme.fg("dim", " • ")}${statusText}`;
	}

	if (width <= 0) return [""];
	const minPadding = Math.min(2, width);
	const truncatedRight = truncateToWidth(right, Math.max(0, width - minPadding), "…");
	const rightWidth = visibleWidth(truncatedRight);
	const availableLeft = Math.max(0, width - rightWidth - minPadding);
	const truncatedLeft = truncateToWidth(left, availableLeft, "…");
	const padding = Math.max(0, width - visibleWidth(truncatedLeft) - rightWidth);
	return [`${truncatedLeft}${" ".repeat(padding)}${truncatedRight}`];
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext, state: State): void {
	ctx.ui.setStatus("chatgpt-limit", undefined);
	ctx.ui.setStatus("statusline", undefined);
	ctx.ui.setFooter((tui, _theme, footerData) => {
		state.requestRender = () => tui.requestRender();
		const unsubscribeBranch = footerData.onBranchChange?.(() => tui.requestRender());
		return {
			dispose() {
				unsubscribeBranch?.();
			},
			invalidate() {},
			render(width: number): string[] {
				return renderOneLineFooter(pi, ctx, state, footerData, width);
			},
		};
	});
}

async function fetchUsage(ctx: ExtensionContext, state: State): Promise<UsageSnapshot | undefined> {
	const model = ctx.model;
	if (!isOpenAICodexProvider(model?.provider)) {
		state.snapshot = undefined;
		state.requestRender();
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		state.snapshot = undefined;
		state.requestRender();
		return undefined;
	}

	const tokenMetadata = getTokenMetadata(auth.apiKey);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.apiKey}`,
		Accept: "application/json",
		"User-Agent": "pi-local-chatgpt-limit",
	};
	if (tokenMetadata.accountId) headers["chatgpt-account-id"] = tokenMetadata.accountId;

	try {
		const response = await fetch(`${CHATGPT_BASE_URL}/wham/usage`, {
			headers,
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			state.snapshot = undefined;
			state.requestRender();
			return undefined;
		}

		const snapshot = parseUsageSnapshot(await response.json());
		if (!snapshot.email && tokenMetadata.email) snapshot.email = tokenMetadata.email;
		if (!snapshot.planType && tokenMetadata.planType) snapshot.planType = tokenMetadata.planType;
		state.snapshot = snapshot;
		state.requestRender();
		return snapshot;
	} catch {
		state.snapshot = undefined;
		state.requestRender();
		return undefined;
	}
}

function queueUsageRefresh(ctx: ExtensionContext, state: State): Promise<UsageSnapshot | undefined> {
	if (state.inFlight) {
		if (!state.queued) {
			const queued = state.inFlight
				.catch(() => undefined)
				.then(() => queueUsageRefresh(ctx, state))
				.finally(() => {
					if (state.queued === queued) state.queued = undefined;
				});
			state.queued = queued;
		}
		return state.queued!;
	}
	const request = fetchUsage(ctx, state).finally(() => {
		if (state.inFlight === request) state.inFlight = undefined;
	});
	state.inFlight = request;
	return request;
}

function refreshInBackground(ctx: ExtensionContext, state: State): void {
	queueUsageRefresh(ctx, state).catch(() => undefined);
}

function usageDetails(snapshot: UsageSnapshot, provider: string | undefined): string[] {
	return [
		`provider: ${provider || "unknown"}`,
		`plan: ${snapshot.planType || "unknown"}`,
		...(snapshot.email ? [`email: ${snapshot.email}`] : []),
		...(snapshot.fiveHour ? [`5-hour: ${usedPercent(snapshot.fiveHour)} used, ${remainingPercent(snapshot.fiveHour)} left, resets ${resetLong(snapshot.fiveHour.resetAt)}`] : []),
		...(snapshot.weekly ? [`weekly: ${usedPercent(snapshot.weekly)} used, ${remainingPercent(snapshot.weekly)} left, resets ${resetLong(snapshot.weekly.resetAt)}`] : []),
		`fetched: ${new Date(snapshot.fetchedAt).toLocaleString()}`,
		`endpoint: ${CHATGPT_BASE_URL}/wham/usage`,
	];
}

export default function (pi: ExtensionAPI) {
	const state: State = { requestRender: () => {} };

	pi.on("session_start", (_event, ctx) => {
		installFooter(pi, ctx, state);
		refreshInBackground(ctx, state);
	});
	pi.on("model_select", (_event, ctx) => refreshInBackground(ctx, state));
	pi.on("agent_settled", (_event, ctx) => refreshInBackground(ctx, state));
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("chatgpt-limit", undefined);
		ctx.ui.setStatus("statusline", undefined);
		ctx.ui.setFooter(undefined);
		state.requestRender = () => {};
	});

	pi.registerCommand("chatgpt-limit", {
		description: "Show ChatGPT Codex 5-hour and weekly usage limits",
		handler: async (_args, ctx) => {
			if (!isOpenAICodexProvider(ctx.model?.provider)) {
				ctx.ui.notify("ChatGPT limits are only available for openai-codex models.", "info");
				return;
			}

			const snapshot = await queueUsageRefresh(ctx, state);
			if (!snapshot) {
				ctx.ui.notify("Could not load ChatGPT usage limits.", "warning");
				return;
			}

			await ctx.ui.select("ChatGPT Codex usage limits", usageDetails(snapshot, ctx.model?.provider));
		},
	});
}

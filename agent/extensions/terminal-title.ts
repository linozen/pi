import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function cwdName(ctx: ExtensionContext): string {
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd ?? process.cwd();
	return path.basename(cwd) || cwd;
}

function title(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const session = pi.getSessionName();
	const cwd = cwdName(ctx);
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

function sanitizeTitle(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function setZedTitle(title: string, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !process.stdout.isTTY) return;

	// Zed's terminal title breadcrumbs listen to OSC 2; Pi's ui.setTitle currently emits OSC 0.
	process.stdout.write(`\x1b]2;${title}\x07`);
}

function setTitle(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const nextTitle = sanitizeTitle(title(pi, ctx));
	ctx.ui.setTitle(nextTitle);
	setZedTitle(nextTitle, ctx);
}

export default function (pi: ExtensionAPI) {
	const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

	function scheduleTitle(ctx: ExtensionContext): void {
		setTitle(pi, ctx);

		const timer = setTimeout(() => {
			pendingTimers.delete(timer);
			setTitle(pi, ctx);
		}, 50);
		pendingTimers.add(timer);
	}

	pi.on("session_start", async (_event, ctx) => {
		scheduleTitle(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		scheduleTitle(ctx);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		scheduleTitle(ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const timer of pendingTimers) clearTimeout(timer);
		pendingTimers.clear();
	});
}

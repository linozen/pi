import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function ring(ctx: { mode: string }): void {
	if (ctx.mode === "tui" && process.stdout.isTTY) process.stdout.write("\x07");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName === "ask_user_question") ring(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.isIdle()) ring(ctx);
	});
}

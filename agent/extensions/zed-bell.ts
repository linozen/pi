import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode === "tui" && ctx.isIdle() && process.stdout.isTTY) process.stdout.write("\x07");
	});
}

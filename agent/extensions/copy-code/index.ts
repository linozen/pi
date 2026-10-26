import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { codeBlocks } from "./core.ts";

export default function copyCode(pi: ExtensionAPI) {
	pi.registerShortcut(Key.ctrlShift("y"), {
		description: "Choose a code block from the latest assistant message to copy",
		handler: async (ctx) => {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const text = entry.message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (!text) continue;
				// shortcut: only the latest assistant message; older blocks need a transcript selection.
				const blocks = codeBlocks(text);
				if (blocks.length === 0) break;
				let selected = blocks[0];
				if (blocks.length > 1) {
					const options = blocks.map((block, index) => {
						const preview = block.code.split("\n").find((line) => line.trim())?.trim() || "(empty)";
						const label = `${block.language} ${preview}`.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80);
						return `${index + 1}. ${label}`;
					});
					const choice = await ctx.ui.select("Copy which code block?", options);
					const index = options.indexOf(choice ?? "");
					if (index < 0) return;
					selected = blocks[index];
				}
				try {
					await copyToClipboard(selected.code);
					ctx.ui.notify("Code block copied; review before executing", "info");
				} catch (error) {
					ctx.ui.notify(`Clipboard copy failed: ${error}`, "error");
				}
				return;
			}
			ctx.ui.notify("No code block in the last assistant message", "warning");
		},
	});
}

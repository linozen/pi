import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { linkifyMarkdown } from "./core.ts";

const FILE_REFERENCE_INSTRUCTION =
	"When referring to an existing local file in assistant prose, put the path by itself in inline code and append an optional 1-based :line or :line:column location, for example `src/parser.ts:24:7`. This lets the UI make the reference openable in the user's editor.";

export default function zedLinks(pi: ExtensionAPI) {
	let cwd = process.cwd();
	let isTui = false;

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		isTui = ctx.mode === "tui";
	});

	pi.on("before_agent_start", (event, ctx) => ctx.mode === "tui" ? ({
		systemPrompt: `${event.systemPrompt}\n\n${FILE_REFERENCE_INSTRUCTION}`,
	}) : undefined);

	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
		if (!isTui || messageType !== "assistant" || isStreaming) return markdown;
		return linkifyMarkdown(markdown, cwd);
	});
}

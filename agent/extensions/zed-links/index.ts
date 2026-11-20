import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { linkifyMarkdown } from "./core.ts";

const FILE_REFERENCE_INSTRUCTION =
	"For this turn, when referring to an existing local file in assistant prose, put the path by itself in inline code and append an optional 1-based :line or :line:column location, for example `src/parser.ts:24:7`. This lets the UI make the reference openable in the user's editor.";

export default function zedLinks(pi: ExtensionAPI) {
	let cwd = process.cwd();
	pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });

	pi.on("before_agent_start", () => ({
		message: { customType: "zed-file-reference-guide", content: FILE_REFERENCE_INSTRUCTION, display: false },
	}));

	pi.registerMarkdownTransformer(
		(markdown, { isStreaming }) => isStreaming ? markdown : linkifyMarkdown(markdown, cwd),
		{ messageTypes: ["assistant"] },
	);
}

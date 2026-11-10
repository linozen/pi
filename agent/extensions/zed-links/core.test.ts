import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { linkifyMarkdown, parseFileReference, zedUrl } from "./core.ts";
import zedLinks from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "pi-zed-links-"));
const sourceDir = join(root, "src");
mkdirSync(sourceDir);
writeFileSync(join(sourceDir, "main.ts"), "export {};\n");
writeFileSync(join(root, "a file (draft)#1.ts"), "export {};\n");
writeFileSync(join(root, "literal:12"), "content\n");

after(() => rmSync(root, { recursive: true, force: true }));

test("parses relative paths and optional source locations", () => {
	assert.deepEqual(parseFileReference("src/main.ts", root), {
		absolutePath: join(sourceDir, "main.ts"),
	});
	assert.deepEqual(parseFileReference("src/main.ts:24:7", root), {
		absolutePath: join(sourceDir, "main.ts"),
		line: 24,
		column: 7,
	});
});

test("prefers an existing filename over interpreting a numeric suffix as a line", () => {
	assert.deepEqual(parseFileReference("literal:12", root), {
		absolutePath: join(root, "literal:12"),
	});
});

test("expands home paths and rejects directories and missing files", () => {
	assert.deepEqual(parseFileReference("~/src/main.ts:2", root, root), {
		absolutePath: join(sourceDir, "main.ts"),
		line: 2,
	});
	assert.equal(parseFileReference("src", root), undefined);
	assert.equal(parseFileReference("src/missing.ts", root), undefined);
});

test("builds encoded Zed URLs with line and column positions", () => {
	assert.equal(
		zedUrl({ absolutePath: join(root, "a file (draft)#1.ts"), line: 9, column: 3 }),
		`zed://file${root}/a%20file%20%28draft%29%231.ts:9:3`,
	);
});

test("links existing file references in inline code", () => {
	const input = "Open `src/main.ts:24:7` and `src/missing.ts`.";
	const expected = `Open [\`src/main.ts:24:7\`](zed://file${root}/src/main.ts:24:7) and \`src/missing.ts\`.`;
	assert.equal(linkifyMarkdown(input, root), expected);
});

test("does not alter fenced or indented code, including inside Markdown containers", () => {
	const input = [
		"```text",
		"`src/main.ts`",
		"```",
		"    `src/main.ts`",
		"> ```",
		"> `src/main.ts`",
		"> ```",
		">     `src/main.ts`",
		"- ```",
		"  `src/main.ts`",
		"  ```",
		"-     `src/main.ts`",
		"Outside `src/main.ts`.",
	].join("\n");
	const expected = [
		"```text",
		"`src/main.ts`",
		"```",
		"    `src/main.ts`",
		"> ```",
		"> `src/main.ts`",
		"> ```",
		">     `src/main.ts`",
		"- ```",
		"  `src/main.ts`",
		"  ```",
		"-     `src/main.ts`",
		`Outside [\`src/main.ts\`](zed://file${root}/src/main.ts).`,
	].join("\n");
	assert.equal(linkifyMarkdown(input, root), expected);
});

test("does not nest links inside inline, reference-style, or multiline Markdown links", () => {
	const input = [
		"Inline [`src/main.ts`](https://example.test/source).",
		"Reference [`src/main.ts`][source].",
		"Title [source](https://example.test \"`src/main.ts`\").",
		"[",
		"`src/main.ts`",
		"](https://example.test/multiline)",
		"Outside `src/main.ts`.",
		"",
		"[source]: https://example.test/reference \"`src/main.ts`\"",
	].join("\n");
	const expected = [
		"Inline [`src/main.ts`](https://example.test/source).",
		"Reference [`src/main.ts`][source].",
		"Title [source](https://example.test \"`src/main.ts`\").",
		"[",
		"`src/main.ts`",
		"](https://example.test/multiline)",
		`Outside [\`src/main.ts\`](zed://file${root}/src/main.ts).`,
		"",
		"[source]: https://example.test/reference \"`src/main.ts`\"",
	].join("\n");
	assert.equal(linkifyMarkdown(input, root), expected);
});

test("supports multiple backtick delimiters and leaves escaped delimiters alone", () => {
	const input = "Use ``src/main.ts`` and ```src/main.ts``` but not \\`src/main.ts\\`.";
	const expected =
		"Use [``src/main.ts``](zed://file" +
		root +
		"/src/main.ts) and [```src/main.ts```](zed://file" +
		root +
		"/src/main.ts) but not \\`src/main.ts\\`.";
	assert.equal(linkifyMarkdown(input, root), expected);
});

test("resumes linkification after CRLF fenced blocks", () => {
	const input = "```text\r\n`src/main.ts`\r\n```\r\nOpen `src/main.ts`.";
	const expected = "```text\r\n`src/main.ts`\r\n```\r\nOpen [`src/main.ts`](zed://file" + root + "/src/main.ts).";
	assert.equal(linkifyMarkdown(input, root), expected);
});

test("does not alter multiline reference-definition titles", () => {
	const input = [
		"[source]: https://example.test",
		"  \"title `src/main.ts`",
		"  continued `src/main.ts`\"",
		"Open `src/main.ts`.",
	].join("\n");
	const expected = [
		"[source]: https://example.test",
		"  \"title `src/main.ts`",
		"  continued `src/main.ts`\"",
		`Open [\`src/main.ts\`](zed://file${root}/src/main.ts).`,
	].join("\n");
	assert.equal(linkifyMarkdown(input, root), expected);
});

test("extension links only finalized assistant messages using the session cwd", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let transformer: ((markdown: string, context: any) => string) | undefined;
	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
		},
		registerMarkdownTransformer(registered: typeof transformer) {
			transformer = registered;
		},
	};

	zedLinks(pi as any);
	handlers.get("session_start")?.({}, { cwd: root, mode: "tui" });
	assert.ok(transformer);

	const input = "Open `src/main.ts`.";
	assert.equal(transformer(input, { messageType: "user", isStreaming: false }), input);
	assert.equal(transformer(input, { messageType: "assistant", isStreaming: true }), input);
	assert.equal(
		transformer(input, { messageType: "assistant", isStreaming: false }),
		`Open [\`src/main.ts\`](zed://file${root}/src/main.ts).`,
	);

	const prompt = handlers.get("before_agent_start")?.({ systemPrompt: "base" }, { mode: "tui" });
	assert.match(prompt.systemPrompt, /path by itself in inline code/);

	handlers.get("session_start")?.({}, { cwd: root, mode: "rpc" });
	assert.equal(transformer(input, { messageType: "assistant", isStreaming: false }), input);
	assert.equal(handlers.get("before_agent_start")?.({ systemPrompt: "base" }, { mode: "rpc" }), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSubdirectoryContext } from "./core.ts";

test("builds a hidden, directory-scoped context message and reports what it contains", () => {
	const path = "project/AGENTS.md";
	const content = "Only selected instructions ✓";
	const { message, summary } = buildSubdirectoryContext([{ path, content }]);
	assert.ok(message);
	assert.equal(message.customType, "subdirectory-context");
	assert.equal(message.display, false);
	assert.match(message.content, /when working in their corresponding directories/);
	assert.ok(message.content.includes(`<project_instructions path="${path}">\n${content}`));
	assert.deepEqual(summary.files.map(file => file.path), [path]);
	assert.equal(summary.size.bytes, Buffer.byteLength(message.content));
	assert.equal(summary.size.tokens, Math.ceil(message.content.length / 4));
	assert.equal(summary.omittedFiles, 0);
	assert.equal(buildSubdirectoryContext([]).message, undefined);
});

test("accounts for files left out at both injection limits", () => {
	const files = Array.from({ length: 23 }, (_, i) => ({ path: `project-${i}/AGENTS.md`, content: "instructions" }));
	const limited = buildSubdirectoryContext(files);
	assert.equal(limited.summary.files.length, 20);
	assert.equal(limited.summary.omittedFiles, 3);
	assert.ok(limited.message && !limited.message.content.includes(files[20].path));

	const huge = { ...files[0], content: "x".repeat(35_000) };
	const truncated = buildSubdirectoryContext([huge, ...files.slice(1)]);
	const keptChars = truncated.message?.content.match(/\nx+/)?.[0].length;
	assert.ok(keptChars);
	assert.equal(truncated.summary.truncatedChars, huge.content.length - (keptChars - 1));
	assert.equal(truncated.summary.omittedFiles, 22);
	assert.deepEqual(truncated.summary.files.map(file => file.path), [huge.path]);
});

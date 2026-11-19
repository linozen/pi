import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSubdirectoryContext } from "./core.ts";

test("reports the paths and size of what was appended, not the inventory", () => {
	const path = "project/AGENTS.md";
	const content = "Only selected instructions ✓";
	const { appended, summary } = buildSubdirectoryContext([{ path, content }]);
	assert.ok(appended.includes(content));
	assert.deepEqual(summary.files.map(file => file.path), [path]);
	assert.equal(summary.size.bytes, Buffer.byteLength(appended));
	assert.equal(summary.size.tokens, Math.ceil(appended.length / 4));
	assert.equal(summary.omittedFiles, 0);
	assert.equal(buildSubdirectoryContext([]).appended, "");
});

test("accounts for files left out at both injection limits", () => {
	const files = Array.from({ length: 23 }, (_, i) => ({ path: `project-${i}/AGENTS.md`, content: "instructions" }));
	const limited = buildSubdirectoryContext(files);
	assert.equal(limited.summary.files.length, 20);
	assert.equal(limited.summary.omittedFiles, 3);
	assert.ok(!limited.appended.includes(files[20].path));

	const huge = { ...files[0], content: "x".repeat(35_000) };
	const truncated = buildSubdirectoryContext([huge, ...files.slice(1)]);
	const keptChars = truncated.appended.match(/\nx+/)?.[0].length;
	assert.ok(keptChars);
	assert.equal(truncated.summary.truncatedChars, huge.content.length - (keptChars - 1));
	assert.equal(truncated.summary.omittedFiles, 22);
	assert.deepEqual(truncated.summary.files.map(file => file.path), [huge.path]);
});

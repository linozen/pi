import assert from "node:assert/strict";
import { test } from "node:test";
import { codeBlocks, resumeCommand } from "./core.ts";

test("quotes both paths when formatting a same-host resume command", () => {
	assert.equal(
		resumeCommand("/tmp/O'Brien repo", "/tmp/Pi's $session.jsonl", "darwin"),
		String.raw`cd '/tmp/O'\''Brien repo' && n-pi --session '/tmp/Pi'\''s $session.jsonl'`,
	);
	assert.equal(resumeCommand("/repo", "/tmp/s.jsonl", "linux"), "cd '/repo' && pi --session '/tmp/s.jsonl'");
});

test("returns each complete fenced block in order without fences", () => {
	assert.deepEqual(codeBlocks("Example:\n```sh\necho one\n```\nThen:\n```zsh\necho two\n```"), [
		{ language: "sh", code: "echo one\n" },
		{ language: "zsh", code: "echo two\n" },
	]);
});

test("accepts longer and tilde fences while preserving code", () => {
	assert.deepEqual(codeBlocks("~~~~bash\nprintf '```'\n~~~~"), [{ language: "bash", code: "printf '```'\n" }]);
	assert.deepEqual(codeBlocks("````\n```\n````"), [{ language: "", code: "```\n" }]);
});

test("ignores incomplete fences and prose", () => {
	assert.deepEqual(codeBlocks("```sh\necho incomplete"), []);
	assert.deepEqual(codeBlocks("No code here"), []);
});

test("preserves blank lines and normalizes CRLF for the clipboard", () => {
	assert.deepEqual(codeBlocks("```sh\r\necho one\r\n\r\necho two\r\n```"), [
		{ language: "sh", code: "echo one\n\necho two\n" },
	]);
});

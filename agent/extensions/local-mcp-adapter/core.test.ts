import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	assertMcpSuccess,
	beginOAuthAttempt,
	cleanupArtifactDirs,
	createOAuthState,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	effectiveLifecycle,
	loadConfigFromPaths,
	metadataCachePayload,
	oauthBindingFingerprint,
	oauthStateMatches,
	parseMetadataCache,
	parseOAuthCompletion,
	prepareMcpResult,
	sanitizeUntrustedText,
	type ResolvedMcpConfig,
	type ToolMetadata,
	withFileLock,
	writePrivateJson,
} from "./core.ts";

const cleanupPaths = new Set<string>();
const artifactDirs = new Set<string>();

afterEach(() => {
	cleanupArtifactDirs(artifactDirs);
	for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
	cleanupPaths.clear();
});

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
	cleanupPaths.add(path);
	return path;
}

test("untrusted project MCP config is skipped without being parsed", () => {
	const root = tempDir();
	const userConfig = join(root, "user.json");
	const projectConfig = join(root, ".mcp.json");
	writeFileSync(userConfig, JSON.stringify({ mcpServers: { user: { command: "user-server" } } }));
	writeFileSync(projectConfig, "{not valid json");

	const loaded = loadConfigFromPaths([userConfig], [projectConfig], false);

	assert.deepEqual(Object.keys(loaded.config.mcpServers), ["user"]);
	assert.deepEqual(loaded.skippedProjectConfigPaths, [projectConfig]);
});

test("trusted project MCP config overrides user config", () => {
	const root = tempDir();
	const userConfig = join(root, "user.json");
	const projectConfig = join(root, ".mcp.json");
	writeFileSync(userConfig, JSON.stringify({ mcpServers: { shared: { command: "user-server" } } }));
	writeFileSync(projectConfig, JSON.stringify({ mcpServers: { shared: { command: "project-server" } } }));

	const loaded = loadConfigFromPaths([userConfig], [projectConfig], true);

	assert.equal(loaded.config.mcpServers.shared.command, "project-server");
	assert.deepEqual(loaded.skippedProjectConfigPaths, []);
});

test("server lifecycle defaults and invalid runtime values fail closed to lazy", () => {
	assert.equal(effectiveLifecycle({}), "lazy");
	assert.equal(effectiveLifecycle({ lifecycle: "eager" }), "eager");
	assert.equal(effectiveLifecycle({ lifecycle: "keep-alive" }), "keep-alive");
	assert.equal(effectiveLifecycle({ lifecycle: "typo" } as never), "lazy");
});

test("trusted config rejects an invalid lifecycle value", () => {
	const root = tempDir();
	const projectConfig = join(root, ".mcp.json");
	writeFileSync(projectConfig, JSON.stringify({ mcpServers: { unsafe: { command: "server", lifecycle: "lzy" } } }));

	assert.throws(() => loadConfigFromPaths([], [projectConfig], true), /invalid lifecycle/);
});

test("metadata cache is accepted only for the same configured server definition", () => {
	const config: ResolvedMcpConfig = {
		mcpServers: { demo: { command: "demo-server", args: ["--stdio"] } },
		settings: { toolPrefix: "server" },
	};
	const tools = new Map<string, ToolMetadata[]>([["demo", [{
		name: "lookup",
		description: "Look something up",
		inputSchema: { type: "object", properties: {} },
		server: "demo",
		fullName: "demo_lookup",
	}]]]);
	const executionScope = { cwd: "/workspace/a", environment: { PATH: "/bin" } };
	const payload = metadataCachePayload(config, tools, executionScope);

	assert.equal(parseMetadataCache(payload, config, executionScope).get("demo")?.[0]?.fullName, "demo_lookup");

	const changedConfig: ResolvedMcpConfig = {
		...config,
		mcpServers: { demo: { command: "different-server", args: ["--stdio"] } },
	};
	assert.equal(parseMetadataCache(payload, changedConfig, executionScope).size, 0);
	assert.equal(parseMetadataCache(payload, config, { ...executionScope, cwd: "/workspace/b" }).size, 0);
	assert.equal(parseMetadataCache(payload, { mcpServers: {}, settings: config.settings }, executionScope).size, 0);
});

test("large MCP text is truncated into a mode-0600 temporary artifact", () => {
	const fullText = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
	const prepared = prepareMcpResult({ content: [{ type: "text", text: fullText }] }, artifactDirs, { maxLines: 3, maxBytes: 1_000 });
	const artifactPath = prepared.details.artifactPath;

	assert.equal(prepared.details.truncated, true);
	assert.ok(artifactPath);
	assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
	assert.match(String(prepared.content[0]?.text), /^line 1\nline 2/);
	assert.match(prepared.content.map(block => String(block.text ?? "")).join("\n"), /Full result saved to mode-0600 temporary artifact/);
	assert.match(readFileSync(artifactPath, "utf8"), /line 10/);

	cleanupArtifactDirs(artifactDirs);
	assert.equal(existsSync(artifactPath), false);
});

test("truncated MCP output stays within Pi's hard byte and line limits including its notice", () => {
	const fullText = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(24)}`).join("\n");
	const prepared = prepareMcpResult({ content: [{ type: "text", text: fullText }] }, artifactDirs);
	const visibleText = prepared.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text as string);
	const joined = visibleText.join("\n");
	const lines = joined ? joined.split("\n").length : 0;
	const bytes = Buffer.byteLength(joined, "utf8");

	assert.ok(lines <= DEFAULT_MAX_LINES);
	assert.ok(bytes <= DEFAULT_MAX_BYTES);
	assert.match(visibleText.join("\n"), /Full result saved to mode-0600 temporary artifact/);
});

test("many MCP text blocks cannot bypass byte and line limits", () => {
	const prepared = prepareMcpResult({
		content: Array.from({ length: DEFAULT_MAX_LINES }, () => ({ type: "text", text: "x\n" })),
	}, artifactDirs);
	const visibleText = prepared.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text as string)
		.join("\n");

	assert.equal(prepared.details.truncated, true);
	assert.ok(visibleText.split("\n").length <= DEFAULT_MAX_LINES);
	assert.ok(Buffer.byteLength(visibleText, "utf8") <= DEFAULT_MAX_BYTES);
});

test("interleaved text blocks with trailing newlines cannot bypass the line limit", () => {
	const content = Array.from({ length: 1_001 }, () => [
		{ type: "text", text: "x\n" },
		{ type: "image", data: "", mimeType: "image/png" },
	]).flat();
	const prepared = prepareMcpResult({ content }, artifactDirs, { maxLines: DEFAULT_MAX_LINES, maxBytes: 1_000_000 });
	const visibleText = prepared.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text as string)
		.join("\n");

	assert.equal(prepared.details.truncated, true);
	assert.ok(visibleText.split("\n").length <= DEFAULT_MAX_LINES);
	assert.match(visibleText, /Full result saved to mode-0600 temporary artifact/);
});

test("mixed MCP content retains text and image block order", () => {
	const prepared = prepareMcpResult({
		content: [
			{ type: "text", text: "before" },
			{ type: "image", data: "abc", mimeType: "image/png" },
			{ type: "text", text: "after" },
		],
	}, artifactDirs);

	assert.deepEqual(prepared.content.map(block => block.type), ["text", "image", "text"]);
	assert.equal(prepared.content[0]?.text, "before");
	assert.equal(prepared.content[2]?.text, "after");
});

test("oversized MCP images are omitted into a secure artifact", () => {
	const prepared = prepareMcpResult({
		content: [{ type: "image", data: "a".repeat(200), mimeType: "image/png" }],
	}, artifactDirs, { maxLines: 100, maxBytes: 50 });

	assert.equal(prepared.details.truncated, true);
	assert.equal(prepared.content.some(block => block.type === "image"), false);
	assert.ok(prepared.details.artifactPath);
	assert.match(readFileSync(prepared.details.artifactPath!, "utf8"), /"type": "image"/);
});

test("structured-only MCP results are serialized into model-visible content", () => {
	const prepared = prepareMcpResult({ content: [], structuredContent: { answer: 42 } }, artifactDirs);

	assert.match(prepared.content.map(block => String(block.text ?? "")).join("\n"), /\[Structured Content\]/);
	assert.match(prepared.content.map(block => String(block.text ?? "")).join("\n"), /"answer":42/);
});

test("oversized structured content is removed from details and retained in the artifact", () => {
	const prepared = prepareMcpResult(
		{ content: [{ type: "text", text: "summary" }], structuredContent: { values: Array.from({ length: 20 }, (_, index) => `value-${index}`) } },
		artifactDirs,
		{ maxLines: 100, maxBytes: 40 },
	);

	assert.equal(prepared.details.structuredContent, null);
	assert.ok(prepared.details.artifactPath);
	assert.match(readFileSync(prepared.details.artifactPath!, "utf8"), /value-19/);
});

test("MCP protocol errors throw instead of returning a successful tool result", () => {
	const prepared = prepareMcpResult({ isError: true, content: [{ type: "text", text: "server rejected request" }] }, artifactDirs);
	assert.throws(() => assertMcpSuccess(prepared), /server rejected request/);
});

test("OAuth bindings change with the server origin and completion requires matching state", () => {
	assert.notEqual(
		oauthBindingFingerprint({ url: "https://one.example/mcp" }),
		oauthBindingFingerprint({ url: "https://two.example/mcp" }),
	);
	assert.equal(parseOAuthCompletion("raw-code"), undefined);
	assert.deepEqual(
		parseOAuthCompletion('{"redirectUrl":"http://localhost:3118/callback?code=abc&state=expected"}'),
		{ code: "abc", state: "expected" },
	);
	assert.equal(oauthStateMatches("expected", "expected"), true);
	assert.equal(oauthStateMatches("expected", "different"), false);
	assert.notEqual(createOAuthState(), createOAuthState());
	const pending: { state?: string; codeVerifier?: string } = { state: "old", codeVerifier: "old-verifier" };
	const firstAttempt = beginOAuthAttempt(pending);
	const secondAttempt = beginOAuthAttempt(pending);
	assert.notEqual(firstAttempt, secondAttempt);
	assert.equal(pending.codeVerifier, undefined);
});

test("untrusted MCP text cannot emit terminal control sequences", () => {
	const unsafe = "before\u001b]52;c;Y2xpcGJvYXJk\u0007middle\u001b[2Jafter\r\u0000";
	assert.equal(sanitizeUntrustedText(unsafe), "beforemiddleafter");
});

test("private file locks are released after success and failure", () => {
	const root = tempDir();
	const path = join(root, "state.json");
	assert.equal(withFileLock(path, () => "ok"), "ok");
	assert.equal(existsSync(`${path}.lock`), false);
	assert.throws(() => withFileLock(path, () => { throw new Error("failed"); }), /failed/);
	assert.equal(existsSync(`${path}.lock`), false);
});

test("private JSON writes replace permissive files atomically with mode 0600", () => {
	const root = tempDir();
	const path = join(root, "private.json");
	writeFileSync(path, "old");
	chmodSync(path, 0o644);

	writePrivateJson(path, { value: "new" });

	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { value: "new" });
});

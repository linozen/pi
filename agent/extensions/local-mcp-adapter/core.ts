import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export type McpTool = {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

export type ServerDefinition = {
	type?: "stdio" | "http";
	auth?: "oauth" | false;
	oauth?: {
		scope?: string;
		redirectUri?: string;
		clientName?: string;
		clientUri?: string;
	};
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	lifecycle?: "lazy" | "eager" | "keep-alive";
	idleTimeout?: number;
	debug?: boolean;
	excludeTools?: string[];
};

export type McpConfig = {
	settings?: {
		idleTimeout?: number;
		toolPrefix?: "server" | "short" | "none";
	};
	mcpServers?: Record<string, ServerDefinition>;
};

export type ResolvedMcpConfig = Required<Pick<McpConfig, "mcpServers">> & Pick<McpConfig, "settings">;
export type ToolMetadata = McpTool & { server: string; fullName: string };

export type LoadedMcpConfig = {
	config: ResolvedMcpConfig;
	skippedProjectConfigPaths: string[];
};

export type PreparedMcpResult = {
	content: Array<Record<string, unknown>>;
	details: {
		isError: boolean;
		structuredContent: unknown;
		truncated: boolean;
		artifactPath?: string;
	};
	errorMessage?: string;
};

type TruncationResult = {
	content: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
};

export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeServers(value: unknown): Record<string, ServerDefinition> {
	if (!isRecord(value)) return {};
	const servers: Record<string, ServerDefinition> = {};
	for (const [name, definition] of Object.entries(value)) {
		if (!isRecord(definition)) continue;
		if (definition.lifecycle !== undefined && !["lazy", "eager", "keep-alive"].includes(String(definition.lifecycle))) {
			throw new Error(`server ${JSON.stringify(name)} has invalid lifecycle ${JSON.stringify(definition.lifecycle)}`);
		}
		servers[name] = definition as ServerDefinition;
	}
	return servers;
}

function readConfigFile(path: string): McpConfig | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) throw new Error("root value must be an object");
		const settings = isRecord(parsed.settings) ? parsed.settings as McpConfig["settings"] : undefined;
		return { mcpServers: normalizeServers(parsed.mcpServers), settings };
	} catch (error) {
		throw new Error(`Invalid MCP config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function mergeConfig(base: McpConfig, next: McpConfig | undefined): McpConfig {
	if (!next) return base;
	return {
		mcpServers: { ...(base.mcpServers ?? {}), ...(next.mcpServers ?? {}) },
		settings: { ...(base.settings ?? {}), ...(next.settings ?? {}) },
	};
}

export function loadConfigFromPaths(userPaths: string[], projectPaths: string[], includeProjectConfig: boolean): LoadedMcpConfig {
	let config: McpConfig = { mcpServers: {} };
	for (const path of userPaths) config = mergeConfig(config, readConfigFile(path));

	const skippedProjectConfigPaths: string[] = [];
	for (const path of projectPaths) {
		if (includeProjectConfig) config = mergeConfig(config, readConfigFile(path));
		else if (existsSync(path)) skippedProjectConfigPaths.push(path);
	}

	return {
		config: { mcpServers: config.mcpServers ?? {}, settings: config.settings },
		skippedProjectConfigPaths,
	};
}

export function effectiveLifecycle(definition: ServerDefinition): "lazy" | "eager" | "keep-alive" {
	if (definition.lifecycle === "eager" || definition.lifecycle === "keep-alive") return definition.lifecycle;
	return "lazy";
}

function toolPrefix(serverName: string, mode: McpConfig["settings"] extends infer S ? S extends { toolPrefix?: infer T } ? T : never : never): string {
	if (mode === "none") return "";
	if (mode === "short") return serverName.replace(/[-_]?mcp$/i, "").replace(/[^a-zA-Z0-9]+/g, "_");
	return serverName.replace(/[^a-zA-Z0-9]+/g, "_");
}

export function fullToolName(serverName: string, toolName: string, settings: McpConfig["settings"]): string {
	const prefix = toolPrefix(serverName, settings?.toolPrefix ?? "server");
	return prefix ? `${prefix}_${toolName}` : toolName;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function serverFingerprint(definition: ServerDefinition, settings: McpConfig["settings"], executionScope: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalize({ definition, settings, executionScope }))).digest("hex");
}

export function oauthBindingFingerprint(definition: ServerDefinition): string {
	return createHash("sha256").update(JSON.stringify(canonicalize({ url: definition.url, auth: definition.auth, oauth: definition.oauth }))).digest("hex");
}

export function parseOAuthCompletion(input: string | undefined): { code: string; state: string } | undefined {
	if (!input) return undefined;
	let redirectUrl: string | undefined;
	try {
		const parsed = JSON.parse(input.trim()) as unknown;
		if (isRecord(parsed)) {
			if (typeof parsed.code === "string" && typeof parsed.state === "string") return { code: parsed.code, state: parsed.state };
			if (typeof parsed.redirectUrl === "string") redirectUrl = parsed.redirectUrl;
		}
	} catch {
		redirectUrl = input.trim();
	}
	if (!redirectUrl) return undefined;
	try {
		const url = new URL(redirectUrl);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		return code && state ? { code, state } : undefined;
	} catch {
		return undefined;
	}
}

export function createOAuthState(): string {
	return randomBytes(32).toString("base64url");
}

export function beginOAuthAttempt(state: { state?: string; codeVerifier?: string }): string {
	const next = createOAuthState();
	state.state = next;
	delete state.codeVerifier;
	return next;
}

export function oauthStateMatches(expected: string, actual: string): boolean {
	const expectedBytes = Buffer.from(expected);
	const actualBytes = Buffer.from(actual);
	return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function writePrivateJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

export function withFileLock<T>(path: string, operation: () => T): T {
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	let descriptor: number | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
			break;
		} catch (error) {
			const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
			if (code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
			} catch {
				// Another process released or replaced the lock.
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (descriptor === undefined) throw new Error(`Timed out waiting for lock ${lockPath}`);
	try {
		return operation();
	} finally {
		closeSync(descriptor);
		try {
			unlinkSync(lockPath);
		} catch {
			// A stale-lock cleaner may already have removed it.
		}
	}
}

function cachedTool(value: unknown, server: string, settings: McpConfig["settings"]): ToolMetadata | undefined {
	if (!isRecord(value) || typeof value.name !== "string" || !value.name) return undefined;
	return {
		name: value.name,
		title: typeof value.title === "string" ? value.title : undefined,
		description: typeof value.description === "string" ? value.description : undefined,
		inputSchema: isRecord(value.inputSchema) ? value.inputSchema : { type: "object", properties: {} },
		server,
		fullName: fullToolName(server, value.name, settings),
	};
}

export function parseMetadataCache(value: unknown, config: ResolvedMcpConfig, executionScope: unknown): Map<string, ToolMetadata[]> {
	const metadata = new Map<string, ToolMetadata[]>();
	if (!isRecord(value) || value.version !== 3 || !isRecord(value.servers)) return metadata;

	for (const [server, definition] of Object.entries(config.mcpServers)) {
		const entry = value.servers[server];
		if (!isRecord(entry) || entry.fingerprint !== serverFingerprint(definition, config.settings, executionScope) || !Array.isArray(entry.tools)) continue;
		metadata.set(server, entry.tools.map(tool => cachedTool(tool, server, config.settings)).filter((tool): tool is ToolMetadata => !!tool));
	}
	return metadata;
}

export function metadataCachePayload(config: ResolvedMcpConfig, metadata: Map<string, ToolMetadata[]>, executionScope: unknown): Record<string, unknown> {
	const servers: Record<string, unknown> = {};
	for (const [server, definition] of Object.entries(config.mcpServers)) {
		const tools = metadata.get(server);
		if (!tools) continue;
		servers[server] = {
			fingerprint: serverFingerprint(definition, config.settings, executionScope),
			tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
		};
	}
	return { version: 3, updatedAt: Date.now(), servers };
}

function safeJson(value: unknown, indentation?: number): string {
	try {
		return JSON.stringify(value, null, indentation) ?? String(value);
	} catch {
		return String(value);
	}
}

export function sanitizeUntrustedText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f]/g, "");
}

function splitLinesForCounting(content: string): string[] {
	if (!content) return [];
	return content.split("\n");
}

export function truncateHeadText(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncationResult {
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
	const totalBytes = Buffer.byteLength(content, "utf8");
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes };
	}

	const output: string[] = [];
	let outputBytes = 0;
	for (const line of lines.slice(0, maxLines)) {
		const separatorBytes = output.length ? 1 : 0;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (outputBytes + separatorBytes + lineBytes > maxBytes) break;
		output.push(line);
		outputBytes += separatorBytes + lineBytes;
	}
	const truncated = output.join("\n");
	return {
		content: truncated,
		truncated: true,
		totalLines,
		totalBytes,
		outputLines: output.length,
		outputBytes: Buffer.byteLength(truncated, "utf8"),
	};
}

export function transformMcpContent(content: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(content)) return [{ type: "text", text: safeJson(content) }];
	return content.map((item) => {
		if (!isRecord(item)) return { type: "text", text: sanitizeUntrustedText(String(item)) };
		if (item.type === "text") return { type: "text", text: typeof item.text === "string" ? sanitizeUntrustedText(item.text) : "" };
		if (item.type === "image") return {
			type: "image",
			data: typeof item.data === "string" ? item.data : "",
			mimeType: typeof item.mimeType === "string" ? sanitizeUntrustedText(item.mimeType) : "image/png",
		};
		if (item.type === "resource") return { type: "text", text: `[Resource]\n${safeJson(item.resource ?? item)}` };
		if (item.type === "resource_link") return { type: "text", text: `[Resource Link]\n${sanitizeUntrustedText(String(item.uri ?? ""))}` };
		return { type: "text", text: safeJson(item) };
	});
}

function writeSecureArtifact(result: Record<string, unknown>, artifactDirs: Set<string>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
	const path = join(dir, "result.json");
	writeFileSync(path, safeJson(result, 2), { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
	artifactDirs.add(dir);
	return path;
}

export function prepareMcpResult(
	result: Record<string, unknown>,
	artifactDirs: Set<string>,
	limits: { maxLines?: number; maxBytes?: number } = {},
): PreparedMcpResult {
	const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
	const structuredContent = result.structuredContent ?? null;
	const structuredText = structuredContent === null ? "" : safeJson(structuredContent);
	const rawBlocks = transformMcpContent(result.content);
	const hasVisibleText = rawBlocks.some(block => block.type === "text" && typeof block.text === "string" && block.text.length > 0);
	if (!hasVisibleText && structuredText) rawBlocks.push({ type: "text", text: `[Structured Content]\n${structuredText}` });
	const transformed: Array<Record<string, unknown>> = [];
	for (const block of rawBlocks) {
		const previous = transformed.at(-1);
		if (block.type === "text" && typeof block.text === "string" && previous?.type === "text" && typeof previous.text === "string") {
			previous.text = `${previous.text}\n${block.text}`;
		} else {
			transformed.push({ ...block });
		}
	}

	const totalTextLines = transformed.reduce((total, block) => {
		return total + (block.type === "text" && typeof block.text === "string" ? splitLinesForCounting(block.text).length : 0);
	}, 0);
	const totalPayloadBytes = transformed.reduce((total, block, index) => {
		const serialized = block.type === "text" && typeof block.text === "string" ? block.text : safeJson(block);
		return total + (index > 0 ? 1 : 0) + Buffer.byteLength(serialized, "utf8");
	}, 0);
	const structuredTruncation = truncateHeadText(structuredText, maxLines, maxBytes);
	const needsArtifact = totalTextLines > maxLines || totalPayloadBytes > maxBytes || structuredTruncation.truncated;
	const artifactPath = needsArtifact ? writeSecureArtifact(result, artifactDirs) : undefined;
	const rawNotice = artifactPath ? `[MCP output truncated. Full result saved to mode-0600 temporary artifact: ${artifactPath}]` : "";
	const notice = truncateHeadText(rawNotice, maxLines, maxBytes);
	let remainingLines = Math.max(0, maxLines - notice.outputLines);
	let remainingBytes = Math.max(0, maxBytes - notice.outputBytes - (notice.content ? 1 : 0));
	let payloadExhausted = false;
	const content: Array<Record<string, unknown>> = [];

	for (const block of transformed) {
		if (payloadExhausted) continue;
		const separatorBytes = content.length ? 1 : 0;
		const blockBudget = Math.max(0, remainingBytes - separatorBytes);
		if (block.type !== "text" || typeof block.text !== "string") {
			const blockBytes = Buffer.byteLength(safeJson(block), "utf8");
			if (blockBytes > blockBudget) {
				payloadExhausted = true;
				continue;
			}
			content.push(block);
			remainingBytes -= separatorBytes + blockBytes;
			continue;
		}
		const truncated = truncateHeadText(block.text, remainingLines, blockBudget);
		if (truncated.content) {
			content.push({ type: "text", text: truncated.content });
			remainingBytes = Math.max(0, remainingBytes - separatorBytes - truncated.outputBytes);
		}
		remainingLines = Math.max(0, remainingLines - truncated.outputLines);
		payloadExhausted = truncated.truncated;
	}
	if (notice.content) content.push({ type: "text", text: notice.content });
	const isError = result.isError === true;
	const visibleText = content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text as string)
		.join("\n");
	return {
		content,
		details: {
			isError,
			structuredContent: structuredTruncation.truncated ? null : structuredContent,
			truncated: needsArtifact,
			...(artifactPath ? { artifactPath } : {}),
		},
		errorMessage: isError ? (visibleText || "MCP server reported an error.") : undefined,
	};
}

export function assertMcpSuccess(result: PreparedMcpResult): void {
	if (result.errorMessage) throw new Error(result.errorMessage);
}

export function cleanupArtifactDirs(artifactDirs: Set<string>): void {
	for (const dir of artifactDirs) rmSync(dir, { recursive: true, force: true });
	artifactDirs.clear();
}


import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type McpTool = {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

type ServerDefinition = {
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

type McpConfig = {
	settings?: {
		idleTimeout?: number;
		toolPrefix?: "server" | "short" | "none";
	};
	mcpServers?: Record<string, ServerDefinition>;
};

type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

type Connection = {
	name: string;
	definition: ServerDefinition;
	client: Client;
	transport: Transport;
	tools: McpTool[];
	lastUsedAt: number;
	inFlight: number;
	status: "connected" | "closed";
};

type ToolMetadata = McpTool & { server: string; fullName: string };

type State = {
	config: Required<Pick<McpConfig, "mcpServers">> & Pick<McpConfig, "settings">;
	connections: Map<string, Connection>;
	connectPromises: Map<string, Promise<Connection>>;
	metadata: Map<string, ToolMetadata[]>;
	lastErrors: Map<string, string>;
	idleTimer?: NodeJS.Timeout;
	refreshPromise?: Promise<void>;
};

const USER_SHARED_CONFIG = join(homedir(), ".config", "mcp", "mcp.json");
const USER_PI_CONFIG = join(homedir(), ".pi", "agent", "mcp.json");
const PROJECT_SHARED_CONFIG = ".mcp.json";
const PROJECT_PI_CONFIG = join(".pi", "mcp.json");
const CACHE_PATH = join(homedir(), ".pi", "agent", "mcp-metadata-cache.json");
const OAUTH_STORE_PATH = join(homedir(), ".pi", "agent", "mcp-oauth.json");
const DEFAULT_REDIRECT_URL = "http://localhost:3118/callback";
const DEFAULT_IDLE_MINUTES = 10;
const RENDER_PREVIEW_LINES = 24;
const RENDER_PREVIEW_CHARS = 4000;

function visibleAnsiWidth(value: string): number {
	return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function takeAnsiPrefix(value: string, width: number): { text: string; rest: string; truncated: boolean } {
	if (width <= 0 || visibleAnsiWidth(value) <= width) return { text: value, rest: "", truncated: false };
	let out = "";
	let visible = 0;
	let i = 0;
	for (; i < value.length && visible < width; i++) {
		if (value[i] === "\x1b") {
			const match = value.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (match) {
				out += match[0];
				i += match[0].length - 1;
				continue;
			}
		}
		out += value[i];
		visible++;
	}
	return { text: out, rest: value.slice(i), truncated: true };
}

function truncateAnsiLine(value: string, width: number): string {
	if (width <= 0 || visibleAnsiWidth(value) <= width) return value;
	const prefix = takeAnsiPrefix(value, Math.max(0, width - 1));
	return `${prefix.text}…\x1b[0m`;
}

function wrapAnsiLine(value: string, width: number): string[] {
	if (width <= 0) return [""];
	const lines: string[] = [];
	let rest = value;
	while (visibleAnsiWidth(rest) > width) {
		const chunk = takeAnsiPrefix(rest, width);
		lines.push(`${chunk.text}\x1b[0m`);
		rest = chunk.rest;
	}
	lines.push(rest);
	return lines;
}

class SimpleText {
	constructor(private readonly value: string, private readonly wrap = false) {}
	render(width: number): string[] {
		if (!this.value) return [];
		const lines = this.value.split("\n");
		return this.wrap ? lines.flatMap(line => wrapAnsiLine(line, width)) : lines.map(line => truncateAnsiLine(line, width));
	}
	invalidate(): void {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function expandPath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const expanded = value
		.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
	if (expanded === "~") return homedir();
	if (expanded.startsWith("~/")) return join(homedir(), expanded.slice(2));
	return expanded;
}

function expandRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) out[key] = expandPath(value) ?? "";
	return out;
}

function readConfig(path: string): McpConfig | undefined {
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isRecord(parsed)) return undefined;
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers as Record<string, ServerDefinition> : {};
	const settings = isRecord(parsed.settings) ? parsed.settings as McpConfig["settings"] : undefined;
	return { mcpServers: servers, settings };
}

function mergeConfig(base: McpConfig, next: McpConfig | undefined): McpConfig {
	if (!next) return base;
	return {
		mcpServers: { ...(base.mcpServers ?? {}), ...(next.mcpServers ?? {}) },
		settings: { ...(base.settings ?? {}), ...(next.settings ?? {}) },
	};
}

function loadConfig(cwd: string): State["config"] {
	const paths = [
		USER_SHARED_CONFIG,
		USER_PI_CONFIG,
		resolve(cwd, PROJECT_SHARED_CONFIG),
		resolve(cwd, PROJECT_PI_CONFIG),
	];
	let config: McpConfig = { mcpServers: {} };
	for (const path of paths) config = mergeConfig(config, readConfig(path));
	return { mcpServers: config.mcpServers ?? {}, settings: config.settings };
}

function toolPrefix(serverName: string, mode: McpConfig["settings"] extends infer S ? S extends { toolPrefix?: infer T } ? T : never : never): string {
	if (mode === "none") return "";
	if (mode === "short") return serverName.replace(/[-_]?mcp$/i, "").replace(/[^a-zA-Z0-9]+/g, "_");
	return serverName.replace(/[^a-zA-Z0-9]+/g, "_");
}

function fullToolName(serverName: string, toolName: string, settings: McpConfig["settings"]): string {
	const prefix = toolPrefix(serverName, settings?.toolPrefix ?? "server");
	return prefix ? `${prefix}_${toolName}` : toolName;
}

function loadCache(): Map<string, ToolMetadata[]> {
	try {
		if (!existsSync(CACHE_PATH)) return new Map();
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.servers)) return new Map();
		const map = new Map<string, ToolMetadata[]>();
		for (const [server, tools] of Object.entries(parsed.servers)) {
			if (Array.isArray(tools)) map.set(server, tools as ToolMetadata[]);
		}
		return map;
	} catch {
		return new Map();
	}
}

function saveCache(metadata: Map<string, ToolMetadata[]>): void {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify({ version: 1, updatedAt: Date.now(), servers: Object.fromEntries(metadata) }, null, 2));
	} catch (error) {
		console.error("local MCP: failed to save metadata cache", error);
	}
}

type OAuthServerState = {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
	state?: string;
};

type OAuthStore = {
	version: 1;
	servers: Record<string, OAuthServerState>;
};

function loadOAuthStore(): OAuthStore {
	try {
		if (!existsSync(OAUTH_STORE_PATH)) return { version: 1, servers: {} };
		const parsed = JSON.parse(readFileSync(OAUTH_STORE_PATH, "utf8")) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.servers)) return { version: 1, servers: {} };
		return { version: 1, servers: parsed.servers as Record<string, OAuthServerState> };
	} catch {
		return { version: 1, servers: {} };
	}
}

function saveOAuthStore(store: OAuthStore): void {
	mkdirSync(dirname(OAUTH_STORE_PATH), { recursive: true });
	writeFileSync(OAUTH_STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
	chmodSync(OAUTH_STORE_PATH, 0o600);
}

function getOAuthServerState(serverName: string): OAuthServerState {
	const store = loadOAuthStore();
	store.servers[serverName] ??= {};
	return store.servers[serverName];
}

function updateOAuthServerState(serverName: string, update: (state: OAuthServerState) => void): void {
	const store = loadOAuthStore();
	store.servers[serverName] ??= {};
	update(store.servers[serverName]);
	saveOAuthStore(store);
}

function clearOAuthServerState(serverName: string): void {
	const store = loadOAuthStore();
	delete store.servers[serverName];
	saveOAuthStore(store);
}

function randomState(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

class LocalOAuthProvider implements OAuthClientProvider {
	private authorizationUrl?: URL;
	private readonly redirect: string;
	private readonly metadata: OAuthClientMetadata;

	constructor(private readonly serverName: string, private readonly definition: ServerDefinition) {
		this.redirect = definition.oauth?.redirectUri ?? DEFAULT_REDIRECT_URL;
		this.metadata = {
			client_name: definition.oauth?.clientName ?? "Pi local MCP adapter",
			client_uri: definition.oauth?.clientUri,
			redirect_uris: [this.redirect],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	get redirectUrl(): string {
		return this.redirect;
	}

	get clientMetadata(): OAuthClientMetadata {
		return this.metadata;
	}

	getAuthorizationUrl(): string | undefined {
		return this.authorizationUrl?.toString();
	}

	state(): string {
		const existing = getOAuthServerState(this.serverName).state;
		if (existing) return existing;
		const next = randomState();
		updateOAuthServerState(this.serverName, state => { state.state = next; });
		return next;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return getOAuthServerState(this.serverName).clientInformation;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		updateOAuthServerState(this.serverName, state => { state.clientInformation = clientInformation; });
	}

	tokens(): OAuthTokens | undefined {
		return getOAuthServerState(this.serverName).tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		updateOAuthServerState(this.serverName, state => { state.tokens = tokens; });
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this.authorizationUrl = authorizationUrl;
	}

	saveCodeVerifier(codeVerifier: string): void {
		updateOAuthServerState(this.serverName, state => { state.codeVerifier = codeVerifier; });
	}

	codeVerifier(): string {
		const verifier = getOAuthServerState(this.serverName).codeVerifier;
		if (!verifier) throw new Error(`No OAuth code verifier saved for ${this.serverName}. Run mcp({ action: "auth-start", server: "${this.serverName}" }) first.`);
		return verifier;
	}

	saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
		updateOAuthServerState(this.serverName, state => { state.discoveryState = discoveryState; });
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return getOAuthServerState(this.serverName).discoveryState;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "all") {
			clearOAuthServerState(this.serverName);
			return;
		}
		updateOAuthServerState(this.serverName, state => {
			if (scope === "client") delete state.clientInformation;
			if (scope === "tokens") delete state.tokens;
			if (scope === "verifier") delete state.codeVerifier;
			if (scope === "discovery") delete state.discoveryState;
		});
	}
}

function shouldUseOAuth(definition: ServerDefinition): boolean {
	return !!definition.url && definition.auth !== false;
}

function oauthProvider(serverName: string, definition: ServerDefinition): LocalOAuthProvider | undefined {
	return shouldUseOAuth(definition) ? new LocalOAuthProvider(serverName, definition) : undefined;
}

function extractAuthCode(input: string | undefined): string | undefined {
	if (!input) return undefined;
	let raw = input.trim();
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (isRecord(parsed)) {
			if (typeof parsed.code === "string") return parsed.code;
			if (typeof parsed.redirectUrl === "string") raw = parsed.redirectUrl;
		}
	} catch {
		// Accept a raw code or URL.
	}
	try {
		return new URL(raw).searchParams.get("code") ?? undefined;
	} catch {
		return raw || undefined;
	}
}

async function startOAuth(state: State, serverName: string): Promise<string> {
	const definition = state.config.mcpServers[serverName];
	if (!definition?.url) throw new Error(`Server ${serverName} is not an HTTP MCP server.`);
	const provider = new LocalOAuthProvider(serverName, definition);
	const result = await auth(provider, { serverUrl: definition.url, scope: definition.oauth?.scope });
	if (result === "AUTHORIZED") return `OAuth already authorized for ${serverName}.`;
	const url = provider.getAuthorizationUrl();
	if (!url) throw new Error(`OAuth did not produce an authorization URL for ${serverName}.`);
	return [
		`OAuth required for ${serverName}.`,
		"Open this URL in your browser:",
		"",
		url,
		"",
		"After approval, copy the full redirected localhost URL and run:",
		`mcp({ action: "auth-complete", server: "${serverName}", args: '{"redirectUrl":"PASTE_URL_HERE"}' })`,
		"",
		"You may also pass just the code value as args.",
	].join("\n");
}

async function completeOAuth(state: State, serverName: string, input: string | undefined): Promise<string> {
	const definition = state.config.mcpServers[serverName];
	if (!definition?.url) throw new Error(`Server ${serverName} is not an HTTP MCP server.`);
	const code = extractAuthCode(input);
	if (!code) throw new Error("OAuth completion needs args containing either {\"redirectUrl\":\"...\"} or {\"code\":\"...\"}.");
	const provider = new LocalOAuthProvider(serverName, definition);
	const result = await auth(provider, { serverUrl: definition.url, authorizationCode: code, scope: definition.oauth?.scope });
	if (result !== "AUTHORIZED") throw new Error(`OAuth did not complete for ${serverName}.`);
	await closeServer(state, serverName);
	state.lastErrors.delete(serverName);
	return `OAuth complete for ${serverName}. Run mcp({ action: "connect", server: "${serverName}" }) to connect.`;
}

function summarizeSchema(schema: unknown): string {
	if (!isRecord(schema)) return "";
	const props = isRecord(schema.properties) ? schema.properties : {};
	const required = Array.isArray(schema.required) ? new Set(schema.required.filter((v): v is string => typeof v === "string")) : new Set<string>();
	const lines = Object.entries(props).slice(0, 40).map(([name, raw]) => {
		const prop = isRecord(raw) ? raw : {};
		const type = typeof prop.type === "string" ? prop.type : "unknown";
		const desc = typeof prop.description === "string" ? ` - ${prop.description}` : "";
		return `- ${name}${required.has(name) ? " (required)" : ""}: ${type}${desc}`;
	});
	return lines.length ? lines.join("\n") : "No parameters.";
}

function metadataText(tool: ToolMetadata): string {
	const schema = summarizeSchema(tool.inputSchema);
	return [
		`${tool.fullName}`,
		`Server: ${tool.server}`,
		tool.description ?? "(no description)",
		schema ? `\nParameters:\n${schema}` : undefined,
	].filter(Boolean).join("\n");
}

function transformContent(content: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(content)) return [{ type: "text", text: JSON.stringify(content) }];
	return content.map((item) => {
		if (!isRecord(item)) return { type: "text", text: String(item) };
		if (item.type === "text") return { type: "text", text: typeof item.text === "string" ? item.text : "" };
		if (item.type === "image") return { type: "image", data: item.data ?? "", mimeType: item.mimeType ?? "image/png" };
		if (item.type === "resource") return { type: "text", text: `[Resource]\n${JSON.stringify(item.resource ?? item)}` };
		if (item.type === "resource_link") return { type: "text", text: `[Resource Link]\n${String(item.uri ?? "")}` };
		return { type: "text", text: JSON.stringify(item) };
	});
}

async function closeConnection(connection: Connection): Promise<void> {
	connection.status = "closed";
	await Promise.allSettled([connection.client.close(), connection.transport.close()]);
}

async function closeServer(state: State, serverName: string): Promise<void> {
	const connection = state.connections.get(serverName);
	if (!connection) return;
	state.connections.delete(serverName);
	await closeConnection(connection);
}

async function closeAll(state: State): Promise<void> {
	if (state.idleTimer) clearInterval(state.idleTimer);
	if (state.refreshPromise) await state.refreshPromise;
	await Promise.allSettled([...state.connectPromises.values()]);
	const connections = [...state.connections.values()];
	state.connections.clear();
	await Promise.allSettled(connections.map(closeConnection));
	saveCache(state.metadata);
}

async function createHttpTransport(serverName: string, definition: ServerDefinition): Promise<Transport> {
	if (!definition.url) throw new Error("HTTP MCP server is missing url");
	const url = new URL(definition.url);
	const headers = expandRecord(definition.headers);
	const provider = oauthProvider(serverName, definition);
	const options = { ...(headers ? { requestInit: { headers } } : {}), ...(provider ? { authProvider: provider } : {}) };

	let streamable: StreamableHTTPClientTransport | undefined;
	try {
		const probe = new Client({ name: "pi-local-mcp-probe", version: "1.0.0" });
		streamable = new StreamableHTTPClientTransport(url, options);
		await probe.connect(streamable);
		await probe.close().catch(() => undefined);
		await streamable.close().catch(() => undefined);
		return new StreamableHTTPClientTransport(url, options);
	} catch (error) {
		await streamable?.close().catch(() => undefined);
		if (error instanceof UnauthorizedError) throw error;
		return new SSEClientTransport(url, options);
	}
}

async function connectServer(state: State, serverName: string): Promise<Connection> {
	const existing = state.connections.get(serverName);
	if (existing?.status === "connected") {
		existing.lastUsedAt = Date.now();
		return existing;
	}
	const inFlight = state.connectPromises.get(serverName);
	if (inFlight) return inFlight;
	const definition = state.config.mcpServers[serverName];
	if (!definition) throw new Error(`Unknown MCP server: ${serverName}`);

	const promise = (async () => {
		const client = new Client({ name: `pi-local-mcp-${serverName}`, version: "1.0.0" });
		let transport: Transport | undefined;
		try {
			if (definition.command) {
				transport = new StdioClientTransport({
					command: definition.command,
					args: definition.args ?? [],
					env: expandRecord(definition.env),
					cwd: expandPath(definition.cwd),
					stderr: definition.debug ? "inherit" : "ignore",
				});
			} else if (definition.url) {
				transport = await createHttpTransport(serverName, definition);
			} else {
				throw new Error(`MCP server ${serverName} needs either command or url`);
			}

			await client.connect(transport);
			const toolsResult = await client.listTools();
			const connection: Connection = {
				name: serverName,
				definition,
				client,
				transport,
				tools: filterTools(toolsResult.tools, definition),
				lastUsedAt: Date.now(),
				inFlight: 0,
				status: "connected",
			};
			state.connections.set(serverName, connection);
			state.metadata.set(serverName, connection.tools.map(tool => ({ ...tool, server: serverName, fullName: fullToolName(serverName, tool.name, state.config.settings) })));
			saveCache(state.metadata);
			state.lastErrors.delete(serverName);
			return connection;
		} catch (error) {
			await Promise.allSettled([client.close(), transport?.close()]);
			throw error;
		}
	})();

	state.connectPromises.set(serverName, promise);
	try {
		return await promise;
	} catch (error) {
		state.lastErrors.set(serverName, error instanceof Error ? error.message : String(error));
		throw error;
	} finally {
		state.connectPromises.delete(serverName);
	}
}

function filterTools(tools: unknown[], definition: ServerDefinition): McpTool[] {
	const excluded = new Set(definition.excludeTools ?? []);
	return tools
		.filter(isRecord)
		.map((tool) => ({
			name: String(tool.name ?? ""),
			title: typeof tool.title === "string" ? tool.title : undefined,
			description: typeof tool.description === "string" ? tool.description : undefined,
			inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
		}))
		.filter((tool) => tool.name && !excluded.has(tool.name));
}

async function refreshServerMetadata(state: State, serverName: string): Promise<void> {
	const connection = await connectServer(state, serverName);
	state.metadata.set(serverName, connection.tools.map(tool => ({ ...tool, server: serverName, fullName: fullToolName(serverName, tool.name, state.config.settings) })));
}

async function refreshAllMetadata(state: State): Promise<void> {
	for (const [serverName, definition] of Object.entries(state.config.mcpServers)) {
		if (definition.lifecycle === "lazy") continue;
		try {
			await refreshServerMetadata(state, serverName);
		} catch (error) {
			state.lastErrors.set(serverName, error instanceof Error ? error.message : String(error));
		}
	}
	saveCache(state.metadata);
}

function allMetadata(state: State): ToolMetadata[] {
	return [...state.metadata.values()].flat();
}

function findTool(state: State, requested: string): ToolMetadata | undefined {
	return allMetadata(state).find((tool) => tool.fullName === requested || tool.name === requested);
}

async function callMcpTool(state: State, toolName: string, argsJson?: string): Promise<Record<string, unknown>> {
	let meta = findTool(state, toolName);
	if (!meta) {
		for (const serverName of Object.keys(state.config.mcpServers)) {
			await refreshServerMetadata(state, serverName).catch(() => undefined);
		}
		meta = findTool(state, toolName);
	}
	if (!meta) throw new Error(`Unknown MCP tool: ${toolName}. Use mcp({ action: "search", query: "..." }) first.`);
	const connection = await connectServer(state, meta.server);
	const args = argsJson ? JSON.parse(argsJson) as Record<string, unknown> : {};
	connection.inFlight++;
	connection.lastUsedAt = Date.now();
	try {
		const result = await connection.client.callTool({ name: meta.name, arguments: args });
		connection.lastUsedAt = Date.now();
		return result as Record<string, unknown>;
	} finally {
		connection.inFlight--;
	}
}

function startIdleCleanup(state: State): void {
	state.idleTimer = setInterval(() => {
		const now = Date.now();
		for (const [serverName, connection] of state.connections) {
			if (connection.definition.lifecycle === "keep-alive") continue;
			const minutes = connection.definition.idleTimeout ?? state.config.settings?.idleTimeout ?? DEFAULT_IDLE_MINUTES;
			if (minutes <= 0) continue;
			if (connection.inFlight === 0 && now - connection.lastUsedAt > minutes * 60_000) {
				void closeServer(state, serverName).catch(error => console.error(`local MCP: failed to close idle server ${serverName}`, error));
			}
		}
	}, 60_000);
}

function statusText(state: State): string {
	const lines = ["MCP servers:"];
	for (const serverName of Object.keys(state.config.mcpServers)) {
		const connected = state.connections.has(serverName);
		const tools = state.metadata.get(serverName)?.length ?? 0;
		const error = state.lastErrors.get(serverName);
		lines.push(`${connected ? "✓" : error ? "✗" : "○"} ${serverName}: ${tools} cached tools${error ? ` (${error})` : ""}`);
	}
	if (lines.length === 1) lines.push("No MCP servers configured.");
	return lines.join("\n");
}

function searchText(state: State, query: string, server?: string): string {
	const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
	const matches = allMetadata(state).filter((tool) => {
		if (server && tool.server !== server) return false;
		const haystack = `${tool.fullName}\n${tool.name}\n${tool.description ?? ""}`.toLowerCase();
		return terms.every(term => haystack.includes(term));
	}).slice(0, 30);
	if (!matches.length) return "No matching MCP tools. Try mcp({ action: \"list\" }) or connect a server first.";
	return matches.map((tool) => `${tool.fullName}\n${tool.description ?? "(no description)"}\n`).join("\n");
}

function firstTextContent(result: { content?: unknown[] }): string {
	const block = result.content?.find(item => isRecord(item) && item.type === "text");
	if (!isRecord(block)) return "";
	return typeof block.text === "string" ? block.text : "";
}

function previewText(text: string): { text: string; truncated: boolean; lineCount: number } {
	const lines = text.split("\n");
	const visibleLines = lines.slice(0, RENDER_PREVIEW_LINES);
	let visible = visibleLines.join("\n");
	let truncated = lines.length > RENDER_PREVIEW_LINES;
	if (visible.length > RENDER_PREVIEW_CHARS) {
		visible = visible.slice(0, RENDER_PREVIEW_CHARS);
		truncated = true;
	}
	return { text: visible, truncated, lineCount: lines.length };
}

function renderMcpResult(result: { content?: unknown[]; isError?: boolean; details?: unknown }, options: { expanded?: boolean; isPartial?: boolean }, theme: { fg: (name: string, value: string) => string }) {
	if (options.isPartial) return new SimpleText(theme.fg("warning", "MCP running..."));

	const text = firstTextContent(result);
	const details = isRecord(result.details) ? result.details : {};
	const count = typeof details.count === "number" ? ` (${details.count})` : "";
	const status = result.isError ? theme.fg("error", "MCP error") : theme.fg("success", `MCP result${count}`);

	if (!options.expanded) {
		const firstLine = text.split("\n").find(line => line.trim())?.trim();
		const suffix = firstLine ? theme.fg("muted", ` — ${firstLine.slice(0, 120)}${firstLine.length > 120 ? "..." : ""}`) : "";
		return new SimpleText(`${status}${suffix}`);
	}

	const preview = previewText(text);
	let output = status;
	if (preview.text) {
		output += "\n" + preview.text.split("\n").map(line => theme.fg("toolOutput", line)).join("\n");
	}
	if (preview.truncated) {
		output += `\n${theme.fg("muted", `... preview truncated (${preview.lineCount} total lines; full result remains in tool context)`)}`;
	}
	return new SimpleText(output, true);
}

function renderMcpCall(args: Record<string, unknown>, theme: { fg: (name: string, value: string) => string }) {
	const action = typeof args.action === "string" ? args.action : "auto";
	const server = typeof args.server === "string" ? ` ${args.server}` : "";
	const tool = typeof args.tool === "string" ? ` ${args.tool}` : "";
	const query = typeof args.query === "string" ? ` ${JSON.stringify(args.query)}` : "";
	return new SimpleText(theme.fg("accent", `mcp ${action}${server}${tool}${query}`));
}

export default function localMcpAdapter(pi: ExtensionAPI) {
	let state: State | undefined;

	pi.registerTool({
		name: "mcp",
		label: "MCP",
		description: "Discover and call tools from configured MCP servers through a small proxy interface.",
		promptSnippet: "Discover and call configured MCP server tools on demand.",
		promptGuidelines: [
			"Use mcp first with action='search' or action='list' to discover MCP tools before calling a specific MCP tool.",
			"When calling MCP tools through mcp, pass args as a JSON string, not as an object.",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["status", "list", "search", "describe", "call", "connect", "disconnect", "refresh", "auth-start", "auth-complete", "auth-clear"],
					description: "Operation to perform. Defaults to status, search, list, or call based on other fields.",
				},
				server: { type: "string", description: "MCP server name." },
				query: { type: "string", description: "Search terms for MCP tool discovery." },
				tool: { type: "string", description: "MCP tool name, usually the prefixed name returned by search/list." },
				args: { type: "string", description: "JSON string of arguments for an MCP tool call." },
			},
			additionalProperties: false,
		},
		renderCall: renderMcpCall,
		renderResult: renderMcpResult,

		async execute(_toolCallId, params) {
			if (!state) {
				return { content: [{ type: "text", text: "MCP extension is not initialized yet." }], isError: true };
			}
			try {
				const action = params.action ?? (params.tool ? "call" : params.query ? "search" : params.server ? "list" : "status");
				if (action === "status") return { content: [{ type: "text", text: statusText(state) }], details: { servers: Object.keys(state.config.mcpServers) } };
				if (action === "auth-start") {
					if (!params.server) throw new Error("server is required for auth-start");
					return { content: [{ type: "text", text: await startOAuth(state, params.server) }] };
				}
				if (action === "auth-complete") {
					if (!params.server) throw new Error("server is required for auth-complete");
					return { content: [{ type: "text", text: await completeOAuth(state, params.server, params.args) }] };
				}
				if (action === "auth-clear") {
					if (!params.server) throw new Error("server is required for auth-clear");
					clearOAuthServerState(params.server);
					await closeServer(state, params.server);
					return { content: [{ type: "text", text: `Cleared OAuth tokens for ${params.server}.` }] };
				}
				if (action === "connect") {
					if (!params.server) throw new Error("server is required for connect");
					await refreshServerMetadata(state, params.server);
					return { content: [{ type: "text", text: `Connected ${params.server}.` }] };
				}
				if (action === "disconnect") {
					if (!params.server) throw new Error("server is required for disconnect");
					await closeServer(state, params.server);
					return { content: [{ type: "text", text: `Disconnected ${params.server}.` }] };
				}
				if (action === "refresh") {
					if (params.server) await refreshServerMetadata(state, params.server);
					else for (const serverName of Object.keys(state.config.mcpServers)) await refreshServerMetadata(state, serverName).catch(() => undefined);
					saveCache(state.metadata);
					return { content: [{ type: "text", text: "MCP metadata refreshed." }] };
				}
				if (action === "list") {
					if (params.server && !state.metadata.has(params.server)) await refreshServerMetadata(state, params.server);
					const tools = params.server ? state.metadata.get(params.server) ?? [] : allMetadata(state);
					const text = tools.length ? tools.map(tool => `${tool.fullName} - ${tool.description ?? "(no description)"}`).join("\n") : statusText(state);
					return { content: [{ type: "text", text }], details: { count: tools.length } };
				}
				if (action === "search") {
					if (!params.query) throw new Error("query is required for search");
					return { content: [{ type: "text", text: searchText(state, params.query, params.server) }] };
				}
				if (action === "describe") {
					if (!params.tool) throw new Error("tool is required for describe");
					const tool = findTool(state, params.tool);
					if (!tool) throw new Error(`Unknown MCP tool: ${params.tool}`);
					return { content: [{ type: "text", text: metadataText(tool) }], details: { tool } };
				}
				if (action === "call") {
					if (!params.tool) throw new Error("tool is required for call");
					const result = await callMcpTool(state, params.tool, params.args);
					return { content: transformContent(result.content), details: { isError: result.isError === true, structuredContent: result.structuredContent ?? null }, isError: result.isError === true };
				}
				throw new Error(`Unknown MCP action: ${action}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], isError: true, details: { message } };
			}
		},
	});

	pi.registerCommand("mcp", {
		description: "Show local MCP adapter status",
		handler: async (_args, ctx) => {
			if (!state) {
				if (ctx.hasUI) ctx.ui.notify("MCP extension is not initialized yet", "error");
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(statusText(state), "info");
		},
	});

	pi.registerCommand("refresh-mcp", {
		description: "Reload MCP config and refresh tool metadata, optionally for one server",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const serverName = args.trim() || undefined;
			let config: State["config"];
			try {
				config = loadConfig(ctx.cwd);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not reload MCP config: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (serverName && !config.mcpServers[serverName]) {
				if (ctx.hasUI) ctx.ui.notify(`Unknown MCP server: ${serverName}`, "error");
				return;
			}

			const previous = state;
			if (previous) await closeAll(previous);
			const metadata = loadCache();
			for (const cachedServer of metadata.keys()) {
				if (!config.mcpServers[cachedServer]) metadata.delete(cachedServer);
			}
			const next: State = {
				config,
				connections: new Map(),
				connectPromises: new Map(),
				metadata,
				lastErrors: new Map(),
			};
			state = next;
			startIdleCleanup(next);

			const targets = serverName ? [serverName] : Object.keys(config.mcpServers);
			let failures = 0;
			for (const target of targets) {
				try {
					await refreshServerMetadata(next, target);
				} catch {
					failures++;
				}
			}
			saveCache(next.metadata);
			if (ctx.hasUI) {
				const summary = failures
					? `MCP refresh completed with ${failures} failure${failures === 1 ? "" : "s"}.`
					: `MCP refresh completed for ${targets.length} server${targets.length === 1 ? "" : "s"}.`;
				ctx.ui.notify(`${summary}\n\n${statusText(next)}`, failures ? "warning" : "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (state) await closeAll(state).catch(error => console.error("local MCP: cleanup failed", error));
		const next: State = {
			config: loadConfig(ctx.cwd),
			connections: new Map(),
			connectPromises: new Map(),
			metadata: loadCache(),
			lastErrors: new Map(),
		};
		state = next;
		startIdleCleanup(next);
		next.refreshPromise = refreshAllMetadata(next).catch(error => console.error("local MCP: eager metadata refresh failed", error));
	});

	pi.on("session_shutdown", async () => {
		const current = state;
		state = undefined;
		if (current) await closeAll(current);
	});
}

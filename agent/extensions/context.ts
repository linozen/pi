import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import * as path from "node:path";

const MESSAGE_TYPE = "context-report";
const SUBDIRECTORY_CONTEXT_NAMES = new Set(["AGENTS.md", "CLAUDE.md"]);
const MAX_INJECTED_FILES = 20;
const MAX_INJECTED_CHARS = 30_000;
const MAX_SCANNED_DIRS = 2_000;
const MAX_DISCOVERED_FILES = 200;
const EXCLUDED_DIRS = new Set([
	".cache",
	".git",
	".go",
	".next",
	".nuxt",
	".pnpm-store",
	".ruff_cache",
	".turbo",
	".venv",
	".vite",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"themes",
	"vendor",
]);

type Size = {
	bytes: number;
	chars: number;
	tokens: number;
};

type ContextFileInfo = {
	path: string;
	bytes: number;
	tokens: number;
};

type SubdirectoryContextFile = ContextFileInfo & {
	dir: string;
	content: string;
};

type ToolInfo = {
	name: string;
	source: string;
	path: string;
	active: boolean;
	descriptionTokens: number;
	schemaTokens: number;
	guidelineTokens: number;
	totalTokens: number;
};

type ContextReport = {
	cwd: string;
	sessionFile?: string;
	model?: string;
	contextUsage?: { tokens: number; limit?: number; percent?: number };
	systemPrompt: Size;
	contextFiles: ContextFileInfo[];
	subdirectoryContextFiles: ContextFileInfo[];
	skills: Array<{ name: string; path?: string; tokens: number }>;
	tools: ToolInfo[];
	activeToolCount: number;
	allToolCount: number;
	commands: Array<{ name: string; source: string; path?: string }>;
	promptParts: Array<{ name: string; tokens: number }>;
	generatedAt: number;
};

function tokenEstimate(value: string): number {
	return Math.ceil(value.length / 4);
}

function sizeOf(value: string): Size {
	return {
		bytes: Buffer.byteLength(value, "utf8"),
		chars: value.length,
		tokens: tokenEstimate(value),
	};
}

function formatNumber(value: number | undefined): string {
	return value === undefined ? "?" : value.toLocaleString("en-US");
}

function formatPct(value: number | undefined): string {
	return value === undefined ? "?" : `${value.toFixed(1)}%`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? null);
	} catch {
		return String(value ?? "");
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function isInsideOrSame(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isStrictlyInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readSubdirectoryContextFile(file: string): SubdirectoryContextFile | undefined {
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		const content = readFileSync(file, "utf8").trim();
		if (!content) return undefined;
		return {
			path: file,
			dir: path.dirname(file),
			bytes: Buffer.byteLength(content, "utf8"),
			tokens: tokenEstimate(content),
			content,
		};
	} catch {
		return undefined;
	}
}

function findSubdirectoryContextFiles(root: string, alreadyLoaded: Set<string>): SubdirectoryContextFile[] {
	if (!existsSync(root)) return [];
	const files: SubdirectoryContextFile[] = [];
	const stack = [root];
	let scannedDirs = 0;

	while (stack.length > 0 && scannedDirs < MAX_SCANNED_DIRS && files.length < MAX_DISCOVERED_FILES) {
		const dir = stack.pop();
		if (!dir) continue;
		scannedDirs++;

		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const fullPath = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				if (!EXCLUDED_DIRS.has(entry.name)) stack.push(fullPath);
				continue;
			}

			const resolved = path.resolve(fullPath);
			if (!entry.isFile() || !SUBDIRECTORY_CONTEXT_NAMES.has(entry.name) || !isStrictlyInside(root, fullPath) || alreadyLoaded.has(resolved)) continue;

			const file = readSubdirectoryContextFile(fullPath);
			if (file) files.push(file);
			if (files.length >= MAX_DISCOVERED_FILES) break;
		}
	}

	return files.sort((a, b) => a.path.localeCompare(b.path));
}

function extractMentionedPaths(prompt: string, cwd: string): string[] {
	const matches = prompt.matchAll(/(?:^|[\s`'"(])(?:@?((?:\.{1,2}|~|\/|[\w.-]+)[^\s`'"<>),;:]*\/[^\s`'"<>),;:]*)|@?([\w.-]+\.(?:rs|ts|tsx|js|jsx|json|toml|yaml|yml|md|py|go|java|kt|swift|c|cc|cpp|h|hpp|sh|zsh|fish)))(?=$|[\s`'"),.;:])/g);
	const paths = new Set<string>();

	for (const match of matches) {
		const raw = (match[1] ?? match[2])?.replace(/[),.;:]+$/, "");
		if (!raw) continue;
		const expanded = raw === "~" || raw.startsWith("~/") ? path.join(process.env.HOME ?? cwd, raw.slice(2)) : raw;
		const resolved = path.resolve(cwd, expanded);
		if (isInsideOrSame(cwd, resolved)) paths.add(resolved);
	}

	return [...paths].slice(0, 50);
}

function existingDirectoryForTarget(root: string, target: string): string | undefined {
	let candidate = target;
	try {
		const stat = lstatSync(candidate);
		if (stat.isSymbolicLink()) return undefined;
		if (stat.isFile()) candidate = path.dirname(candidate);
	} catch {
		if (path.extname(candidate)) candidate = path.dirname(candidate);
	}

	const realRoot = realpathSync(root);
	while (isInsideOrSame(root, candidate)) {
		try {
			const stat = lstatSync(candidate);
			if (stat.isSymbolicLink()) return undefined;
			if (stat.isDirectory()) {
				const realCandidate = realpathSync(candidate);
				return isInsideOrSame(realRoot, realCandidate) ? candidate : undefined;
			}
		} catch {
			// Walk upward until an existing directory establishes the trust boundary.
		}

		const parent = path.dirname(candidate);
		if (parent === candidate) break;
		candidate = parent;
	}
	return undefined;
}

function findRelevantSubdirectoryContextFiles(root: string, prompt: string, alreadyLoaded: Set<string>): SubdirectoryContextFile[] {
	if (!existsSync(root)) return [];
	const targets = extractMentionedPaths(prompt, root);
	if (targets.length === 0) return [];

	const files = new Map<string, SubdirectoryContextFile>();
	for (const target of targets) {
		let dir = existingDirectoryForTarget(root, target);
		while (dir && isInsideOrSame(root, dir)) {
			if (isStrictlyInside(root, dir)) {
				for (const name of SUBDIRECTORY_CONTEXT_NAMES) {
					const candidate = path.join(dir, name);
					const resolved = path.resolve(candidate);
					if (alreadyLoaded.has(resolved) || files.has(resolved)) continue;
					const file = readSubdirectoryContextFile(candidate);
					if (file) files.set(resolved, file);
				}
			}

			if (dir === root) break;
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function buildSubdirectoryContextSections(files: SubdirectoryContextFile[]): { sections: string[]; omittedFiles: number; truncatedChars: number } {
	const sections: string[] = [];
	let chars = 0;
	let truncatedChars = 0;

	for (const file of files.slice(0, MAX_INJECTED_FILES)) {
		const prefix = `<project_instructions path="${file.path}">\n`;
		const suffix = "\n</project_instructions>";
		const remaining = MAX_INJECTED_CHARS - chars - prefix.length - suffix.length;
		if (remaining <= 0) {
			truncatedChars += file.content.length;
			break;
		}

		let content = file.content;
		if (file.content.length > remaining) {
			const notice = "\n\n[Subdirectory context truncated.]";
			const keptChars = Math.max(0, remaining - notice.length);
			content = `${file.content.slice(0, keptChars)}${notice.slice(0, remaining - keptChars)}`;
			truncatedChars += file.content.length - keptChars;
		}
		const section = `${prefix}${content}${suffix}`;
		sections.push(section);
		chars += section.length;
	}

	return {
		sections,
		omittedFiles: Math.max(0, files.length - MAX_INJECTED_FILES),
		truncatedChars,
	};
}

function loadedContextFilesFromOptions(options: unknown): ContextFileInfo[] {
	const optionRecord = asRecord(options);
	return (Array.isArray(optionRecord.contextFiles) ? optionRecord.contextFiles : []).map((file) => {
		const record = asRecord(file);
		const path = getString(record, "path") ?? "(unknown)";
		const content = getString(record, "content") ?? "";
		return {
			path,
			bytes: Buffer.byteLength(content, "utf8"),
			tokens: tokenEstimate(content),
		};
	});
}

function buildReport(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextReport {
	const options = ctx.getSystemPromptOptions();
	const optionRecord = asRecord(options);
	const systemPrompt = ctx.getSystemPrompt();
	const activeTools = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();
	const usage = ctx.getContextUsage();
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const contextFiles = loadedContextFilesFromOptions(options);
	const alreadyLoadedContextPaths = new Set(contextFiles.map(file => path.resolve(file.path)));
	const subdirectoryContextFiles = findSubdirectoryContextFiles(ctx.cwd, alreadyLoadedContextPaths);

	const skills = (Array.isArray(optionRecord.skills) ? optionRecord.skills : []).map((skill) => {
		const record = asRecord(skill);
		const name = getString(record, "name") ?? getString(record, "command") ?? "(unnamed)";
		const path = getString(record, "path");
		const description = getString(record, "description") ?? "";
		const content = getString(record, "content") ?? getString(record, "instructions") ?? "";
		return { name, path, tokens: tokenEstimate(`${description}\n${content}`) };
	});

	const tools = allTools.map((tool) => {
		const sourceInfo = asRecord((tool as unknown as Record<string, unknown>).sourceInfo);
		const description = typeof tool.description === "string" ? tool.description : "";
		const schema = safeJson((tool as unknown as Record<string, unknown>).parameters);
		const guidelines = Array.isArray((tool as unknown as Record<string, unknown>).promptGuidelines)
			? ((tool as unknown as Record<string, unknown>).promptGuidelines as unknown[]).filter((x): x is string => typeof x === "string").join("\n")
			: "";
		const promptSnippet = typeof (tool as unknown as Record<string, unknown>).promptSnippet === "string" ? (tool as unknown as Record<string, unknown>).promptSnippet as string : "";
		const descriptionTokens = tokenEstimate(`${description}\n${promptSnippet}`);
		const schemaTokens = tokenEstimate(schema);
		const guidelineTokens = tokenEstimate(guidelines);
		return {
			name: tool.name,
			source: getString(sourceInfo, "source") ?? "unknown",
			path: getString(sourceInfo, "path") ?? "unknown",
			active: activeTools.has(tool.name),
			descriptionTokens,
			schemaTokens,
			guidelineTokens,
			totalTokens: descriptionTokens + schemaTokens + guidelineTokens,
		};
	}).sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));

	const commands = pi.getCommands().map((command) => ({
		name: command.name,
		source: command.source,
		path: command.sourceInfo?.path,
	}));

	const promptParts = [
		{ name: "system prompt total", tokens: tokenEstimate(systemPrompt) },
		{ name: "startup context files", tokens: contextFiles.reduce((sum, item) => sum + item.tokens, 0) },
		{ name: "subdirectory context files available to injector", tokens: subdirectoryContextFiles.reduce((sum, item) => sum + item.tokens, 0) },
		{ name: "active tool definitions", tokens: tools.filter(t => t.active).reduce((sum, item) => sum + item.totalTokens, 0) },
		{ name: "skills metadata", tokens: skills.reduce((sum, item) => sum + item.tokens, 0) },
	];

	return {
		cwd: ctx.cwd,
		sessionFile: ctx.sessionManager.getSessionFile(),
		model,
		contextUsage: usage ? { tokens: usage.tokens ?? 0, limit: usage.contextWindow, percent: usage.percent ?? undefined } : undefined,
		systemPrompt: sizeOf(systemPrompt),
		contextFiles,
		subdirectoryContextFiles,
		skills,
		tools,
		activeToolCount: activeTools.size,
		allToolCount: allTools.length,
		commands,
		promptParts,
		generatedAt: Date.now(),
	};
}

function renderReport(report: ContextReport, expanded: boolean, theme: { fg: (name: string, value: string) => string; bg: (name: string, value: string) => string; bold: (value: string) => string }) {
	const activeTools = report.tools.filter(t => t.active);
	const mcpTools = report.tools.filter(t => t.name === "mcp" || /mcp/i.test(t.name) || /mcp/i.test(t.path) || /mcp/i.test(t.source));
	const contextFileTokens = report.contextFiles.reduce((sum, item) => sum + item.tokens, 0);
	const subdirectoryContextFileTokens = report.subdirectoryContextFiles.reduce((sum, item) => sum + item.tokens, 0);
	const activeToolTokens = activeTools.reduce((sum, item) => sum + item.totalTokens, 0);
	const mcpTokens = mcpTools.filter(t => t.active).reduce((sum, item) => sum + item.totalTokens, 0);

	const lines: string[] = [];
	lines.push(`${theme.fg("accent", theme.bold("Context report"))} ${theme.fg("dim", new Date(report.generatedAt).toLocaleTimeString())}`);
	lines.push(`cwd: ${report.cwd}`);
	if (report.model) lines.push(`model: ${report.model}`);
	if (report.contextUsage) {
		lines.push(`context usage: ${formatNumber(report.contextUsage.tokens)} / ${formatNumber(report.contextUsage.limit)} tokens (${formatPct(report.contextUsage.percent)})`);
	}
	lines.push(`system prompt: ${formatNumber(report.systemPrompt.tokens)} tokens (${formatNumber(report.systemPrompt.bytes)} bytes)`);
	lines.push(`startup context files: ${report.contextFiles.length} files, ${formatNumber(contextFileTokens)} tokens`);
	lines.push(`subdirectory context files: ${report.subdirectoryContextFiles.length} files, ${formatNumber(subdirectoryContextFileTokens)} tokens available to injector`);
	lines.push(`tools: ${report.activeToolCount}/${report.allToolCount} active, ~${formatNumber(activeToolTokens)} active-definition tokens`);
	lines.push(`MCP/tool adapter definitions: ~${formatNumber(mcpTokens)} active tokens across ${mcpTools.filter(t => t.active).length} active MCP-ish tool(s)`);
	lines.push(`commands: ${report.commands.length} extension/prompt/skill commands`);

	lines.push("");
	lines.push(theme.fg("accent", "Startup context files"));
	if (report.contextFiles.length === 0) lines.push("  none");
	for (const file of report.contextFiles) lines.push(`  ${formatNumber(file.tokens).padStart(6)} tok  ${formatNumber(file.bytes).padStart(7)} B  ${file.path}`);

	lines.push("");
	lines.push(theme.fg("accent", "Subdirectory context files available to injector"));
	if (report.subdirectoryContextFiles.length === 0) lines.push("  none");
	for (const file of report.subdirectoryContextFiles) lines.push(`  ${formatNumber(file.tokens).padStart(6)} tok  ${formatNumber(file.bytes).padStart(7)} B  ${file.path}`);

	lines.push("");
	lines.push(theme.fg("accent", expanded ? "Active tools" : "Largest active tools (expand for all)"));
	const shownTools = expanded ? activeTools : activeTools.slice(0, 10);
	for (const tool of shownTools) {
		lines.push(`  ${formatNumber(tool.totalTokens).padStart(6)} tok  ${tool.name}  ${theme.fg("dim", tool.source)}`);
		if (expanded) lines.push(`          schema ${formatNumber(tool.schemaTokens)} · desc ${formatNumber(tool.descriptionTokens)} · guidelines ${formatNumber(tool.guidelineTokens)} · ${tool.path}`);
	}
	if (!expanded && activeTools.length > shownTools.length) lines.push(theme.fg("dim", `  … ${activeTools.length - shownTools.length} more active tools`));

	if (expanded) {
		lines.push("");
		lines.push(theme.fg("accent", "Prompt part estimates"));
		for (const part of report.promptParts) lines.push(`  ${formatNumber(part.tokens).padStart(6)} tok  ${part.name}`);

		lines.push("");
		lines.push(theme.fg("accent", "Skills"));
		if (report.skills.length === 0) lines.push("  none");
		for (const skill of report.skills) lines.push(`  ${formatNumber(skill.tokens).padStart(6)} tok  ${skill.name}${skill.path ? `  ${theme.fg("dim", skill.path)}` : ""}`);

		lines.push("");
		lines.push(theme.fg("accent", "Commands"));
		for (const command of report.commands) lines.push(`  /${command.name}  ${theme.fg("dim", `${command.source}${command.path ? ` · ${command.path}` : ""}`)}`);
	}

	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
}

export default function contextExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const eventCwd = event.systemPromptOptions.cwd;
		if (!eventCwd) return;

		const alreadyLoaded = new Set(loadedContextFilesFromOptions(event.systemPromptOptions).map((file) => path.resolve(file.path)));
		const files = findRelevantSubdirectoryContextFiles(eventCwd, event.prompt, alreadyLoaded);
		if (files.length === 0) return;

		const { sections, omittedFiles, truncatedChars } = buildSubdirectoryContextSections(files);
		if (sections.length === 0) return;

		const notes = [];
		if (omittedFiles > 0) notes.push(`Omitted ${omittedFiles} additional subdirectory context file(s) due to MAX_INJECTED_FILES=${MAX_INJECTED_FILES}.`);
		if (truncatedChars > 0) notes.push(`Truncated ${truncatedChars} character(s) due to MAX_INJECTED_CHARS=${MAX_INJECTED_CHARS}.`);

		const noteBlock = notes.length > 0 ? `\n\n${notes.map((note) => `[${note}]`).join("\n")}` : "";
		return {
			systemPrompt: `${event.systemPrompt}\n\n# Subdirectory AGENTS.md / CLAUDE.md files\n\n${sections.join("\n\n")}${noteBlock}`,
		};
	});

	pi.registerEntryRenderer(MESSAGE_TYPE, (entry, { expanded }, theme) => {
		return renderReport(entry.data as ContextReport, expanded, theme);
	});

	pi.registerCommand("context", {
		description: "Show loaded prompt/context files, tool schema sizes, MCP overhead, commands, and context usage",
		handler: async (_args, ctx) => {
			const report = buildReport(pi, ctx);
			pi.appendEntry(MESSAGE_TYPE, report);
		},
	});
}

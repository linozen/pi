import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const AGENTS_FILE = "AGENTS.md";
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

function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function findSubdirectoryAgents(root: string): string[] {
	const files: string[] = [];
	const stack = [root];

	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			let stat;
			try {
				stat = statSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				if (!EXCLUDED_DIRS.has(entry)) stack.push(fullPath);
				continue;
			}

			if (entry === AGENTS_FILE && isInside(root, fullPath)) {
				files.push(fullPath);
			}
		}
	}

	return files.sort();
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const cwd = event.systemPromptOptions.cwd;
		if (!cwd || !existsSync(cwd)) return;

		const alreadyLoaded = new Set(event.systemPromptOptions.contextFiles?.map((file) => path.resolve(file.path)) ?? []);
		const files = findSubdirectoryAgents(cwd).filter((file) => !alreadyLoaded.has(path.resolve(file)));
		if (files.length === 0) return;

		const sections = files.flatMap((file) => {
			try {
				const content = readFileSync(file, "utf8").trim();
				if (content.length === 0) return [];
				return [`<project_instructions path="${file}">\n${content}\n</project_instructions>`];
			} catch {
				return [];
			}
		});
		if (sections.length === 0) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n# Subdirectory AGENTS.md files\n\n${sections.join("\n\n")}`,
		};
	});
}

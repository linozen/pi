export type Size = { bytes: number; chars: number; tokens: number };
export type ContextFileInfo = { path: string; bytes: number; tokens: number };

export function tokenEstimate(value: string): number {
	return Math.ceil(value.length / 4);
}

export function sizeOf(value: string): Size {
	return { bytes: Buffer.byteLength(value, "utf8"), chars: value.length, tokens: tokenEstimate(value) };
}

const MAX_FILES = 20;
const MAX_CHARS = 30_000;

export function buildSubdirectoryContext(files: readonly { path: string; content: string }[]) {
	const included: ContextFileInfo[] = [];
	const sections: string[] = [];
	let chars = 0;
	let truncatedChars = 0;
	for (const file of files.slice(0, MAX_FILES)) {
		const prefix = `<project_instructions path="${file.path}">\n`;
		const suffix = "\n</project_instructions>";
		const remaining = MAX_CHARS - chars - prefix.length - suffix.length;
		if (remaining <= 0) break;

		let content = file.content;
		if (content.length > remaining) {
			const notice = "\n\n[Subdirectory context truncated.]";
			const kept = Math.max(0, remaining - notice.length);
			content = content.slice(0, kept) + notice.slice(0, remaining - kept);
			truncatedChars += file.content.length - kept;
		}
		const section = prefix + content + suffix;
		sections.push(section);
		included.push({ path: file.path, ...sizeOf(section) });
		chars += section.length + 2; // Account for the separator between sections.
	}

	const omittedFiles = files.length - included.length;
	const notes = [];
	if (omittedFiles > 0) notes.push(`[Omitted ${omittedFiles} additional subdirectory context file(s) due to injection limits.]`);
	if (truncatedChars > 0) notes.push(`[Truncated ${truncatedChars} character(s) due to the ${MAX_CHARS}-character limit.]`);
	const text = ["\n\n# Subdirectory AGENTS.md / CLAUDE.md files", ...sections, ...notes].join("\n\n");
	const appended = sections.length ? text : "";
	return { appended, summary: { files: included, size: sizeOf(appended), omittedFiles, truncatedChars } };
}

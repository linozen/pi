import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type FileReference = {
	absolutePath: string;
	line?: number;
	column?: number;
};

function existingFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function expandPath(path: string, cwd: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return resolve(home, path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function parseFileReference(value: string, cwd: string, home = homedir()): FileReference | undefined {
	if (!value || value !== value.trim() || value.includes("\n") || value.includes("\0")) return undefined;

	const wholePath = expandPath(value, cwd, home);
	if (existingFile(wholePath)) return { absolutePath: wholePath };

	const lineAndColumn = /^(.*):([1-9]\d*):([1-9]\d*)$/.exec(value);
	if (lineAndColumn?.[1]) {
		const absolutePath = expandPath(lineAndColumn[1], cwd, home);
		if (existingFile(absolutePath)) {
			return {
				absolutePath,
				line: Number(lineAndColumn[2]),
				column: Number(lineAndColumn[3]),
			};
		}
	}

	const lineOnly = /^(.*):([1-9]\d*)$/.exec(value);
	if (!lineOnly?.[1]) return undefined;

	const absolutePath = expandPath(lineOnly[1], cwd, home);
	if (!existingFile(absolutePath)) return undefined;
	return { absolutePath, line: Number(lineOnly[2]) };
}

function encodePathSegment(segment: string): string {
	return encodeURIComponent(segment).replace(/[!'()*]/g, character =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

export function zedUrl(reference: FileReference): string {
	const encodedPath = reference.absolutePath.split("/").map(encodePathSegment).join("/");
	let url = `zed://file${encodedPath}`;
	if (reference.line !== undefined) url += `:${reference.line}`;
	if (reference.column !== undefined) url += `:${reference.column}`;
	return url;
}

function escapedAt(value: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) backslashes++;
	return backslashes % 2 === 1;
}

function backtickRun(value: string, start: number): number {
	let end = start;
	while (value[end] === "`") end++;
	return end - start;
}

function matchingBackticks(value: string, start: number, length: number): number | undefined {
	for (let cursor = start; cursor < value.length; cursor++) {
		if (value[cursor] !== "`" || escapedAt(value, cursor)) continue;
		const run = backtickRun(value, cursor);
		if (run === length) return cursor;
		cursor += run - 1;
	}
	return undefined;
}

type MarkdownContext = {
	bracketDepth: number;
	linkDestinationDepth: number;
	pendingDestination: boolean;
};

function updateMarkdownContext(value: string, context: MarkdownContext): void {
	for (let cursor = 0; cursor < value.length; cursor++) {
		if (escapedAt(value, cursor)) continue;
		const character = value[cursor];

		if (context.linkDestinationDepth > 0) {
			if (character === "(") context.linkDestinationDepth++;
			if (character === ")") context.linkDestinationDepth--;
			continue;
		}

		if (context.pendingDestination) {
			if (/\s/.test(character)) continue;
			context.pendingDestination = false;
			if (character === "(") {
				context.linkDestinationDepth = 1;
				continue;
			}
		}

		if (character === "[") context.bracketDepth++;
		if (character === "]" && context.bracketDepth > 0) {
			context.bracketDepth--;
			if (context.bracketDepth === 0) context.pendingDestination = true;
		}
	}
}

function containerBody(line: string): string {
	let body = line;
	while (true) {
		const quote = /^ {0,3}>[ \t]?/.exec(body);
		if (!quote) break;
		body = body.slice(quote[0].length);
	}
	const listItem = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/.exec(body);
	return listItem ? body.slice(listItem[0].length) : body;
}

function linkifyLine(line: string, cwd: string, context: MarkdownContext): string {
	if (/^(?: {4}|\t)/.test(containerBody(line))) return line;

	let output = "";
	let cursor = 0;
	while (cursor < line.length) {
		const opening = line.indexOf("`", cursor);
		if (opening < 0) {
			const remainder = line.slice(cursor);
			updateMarkdownContext(remainder, context);
			return output + remainder;
		}

		const prefix = line.slice(cursor, opening);
		updateMarkdownContext(prefix, context);
		output += prefix;
		if (escapedAt(line, opening)) {
			output += "`";
			cursor = opening + 1;
			continue;
		}

		const delimiterLength = backtickRun(line, opening);
		const contentStart = opening + delimiterLength;
		const closing = matchingBackticks(line, contentStart, delimiterLength);
		if (closing === undefined) {
			const remainder = line.slice(opening);
			updateMarkdownContext(remainder, context);
			return output + remainder;
		}

		const spanEnd = closing + delimiterLength;
		const codeSpan = line.slice(opening, spanEnd);
		const content = line.slice(contentStart, closing);
		const reference = parseFileReference(content, cwd);

		if (reference && context.bracketDepth === 0 && context.linkDestinationDepth === 0) {
			output += `[${codeSpan}](${zedUrl(reference)})`;
		} else {
			output += codeSpan;
		}
		cursor = spanEnd;
	}
	return output;
}

function fenceStart(line: string): { marker: string; length: number } | undefined {
	const match = /^ {0,3}(`+|~+)/.exec(line);
	if (!match || match[1].length < 3) return undefined;
	const marker = match[1][0];
	if (marker === "`" && line.slice(match[0].length).includes("`")) return undefined;
	return { marker, length: match[1].length };
}

function closesFence(line: string, marker: string, minimumLength: number): boolean {
	const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
	return Boolean(match && match[1][0] === marker && match[1].length >= minimumLength);
}

function continuationTitle(line: string): { endMarker: string; closed: boolean } | undefined {
	const match = /^[ \t]{1,3}(["'(])/.exec(line);
	if (!match) return undefined;
	const endMarker = match[1] === "(" ? ")" : match[1];
	const remainder = line.slice(match[0].length);
	for (let cursor = 0; cursor < remainder.length; cursor++) {
		if (remainder[cursor] === endMarker && !escapedAt(remainder, cursor)) {
			return { endMarker, closed: true };
		}
	}
	return { endMarker, closed: false };
}

function closesContinuationTitle(line: string, endMarker: string): boolean {
	for (let cursor = 0; cursor < line.length; cursor++) {
		if (line[cursor] === endMarker && !escapedAt(line, cursor)) return true;
	}
	return false;
}

export function linkifyMarkdown(markdown: string, cwd: string): string {
	let fence: { marker: string; length: number } | undefined;
	let pendingReferenceTitle = false;
	let referenceTitleEnd: string | undefined;
	const context: MarkdownContext = {
		bracketDepth: 0,
		linkDestinationDepth: 0,
		pendingDestination: false,
	};
	return markdown
		.split(/(\r?\n)/)
		.map(part => {
			if (part === "\n" || part === "\r\n") return part;
			const body = containerBody(part);
			if (fence) {
				if (closesFence(body, fence.marker, fence.length)) fence = undefined;
				return part;
			}

			if (referenceTitleEnd) {
				if (closesContinuationTitle(body, referenceTitleEnd)) referenceTitleEnd = undefined;
				return part;
			}
			if (pendingReferenceTitle) {
				pendingReferenceTitle = false;
				const title = continuationTitle(body);
				if (title) {
					if (!title.closed) referenceTitleEnd = title.endMarker;
					return part;
				}
			}
			const openingFence = fenceStart(body);
			if (openingFence) {
				fence = openingFence;
				return part;
			}
			if (/^ {0,3}\[[^\]]+\]:/.test(body)) {
				pendingReferenceTitle = true;
				return part;
			}
			return linkifyLine(part, cwd, context);
		})
		.join("");
}

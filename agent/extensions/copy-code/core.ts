export interface CodeBlock {
	language: string;
	code: string;
}

export function codeBlocks(markdown: string): CodeBlock[] {
	const lines = markdown.split(/\r?\n/);
	const blocks: CodeBlock[] = [];
	let marker = "";
	let language = "";
	let start = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!marker) {
			const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (match) {
				marker = match[1];
				language = match[2].trim().split(/\s+/)[0];
				start = i + 1;
			}
			continue;
		}
		const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
		if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) {
			blocks.push({ language, code: lines.slice(start, i).join("\n") + "\n" });
			marker = "";
		}
	}
	return blocks;
}

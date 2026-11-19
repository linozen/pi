import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

async function* records(stdout: AsyncIterable<string>) {
	let pending = "";
	for await (const chunk of stdout) {
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop()!;
		for (const line of lines) yield JSON.parse(line);
	}
}

async function withPi(cwd: string, home: string, flags: string[], run: (request: (type: string, fields?: object) => Promise<any>) => Promise<void>) {
	const extensions = ["ask-user-question/index.ts", "child-skills.ts", "context.ts", "copy-code/index.ts", "subagents/index.ts"];
	const child = spawn("pi", ["--mode", "rpc", "--offline", "--no-session", "--no-mcp", ...flags,
		...extensions.flatMap(path => ["--extension", fileURLToPath(new URL(`../extensions/${path}`, import.meta.url))]),
		...["handoff", "verify"].flatMap(name => ["--prompt-template", fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url))]),
	], {
		cwd,
		env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
		timeout: 15_000,
		killSignal: "SIGKILL",
	});
	const closed = once(child, "close");
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	const output = records(child.stdout.setEncoding("utf8"));
	let seq = 0;
	try {
		await run(async (type, fields) => {
			const id = String(++seq);
			child.stdin.write(JSON.stringify({ type, id, ...fields }) + "\n");
			for (;;) {
				const next = await output.next();
				assert.ok(!next.done, `Pi stopped before replying to ${type}: ${stderr}`);
				if (next.value.type !== "response" || next.value.id !== id) continue;
				assert.equal(next.value.success, true, next.value.error);
				return next.value.data;
			}
		});
	} finally {
		child.stdin.end();
		const [code] = await closed;
		assert.equal(code, 0, stderr);
	}
}

test("Pi RPC starts without credentials, registers the tools, and honors child-skill trust and opt-in", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-rpc-smoke-"));
	const cwd = join(root, "workspace");
	const home = join(root, "home");
	const skillDir = join(cwd, "child/.pi/skills/child-sample");
	try {
		mkdirSync(skillDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"));
		mkdirSync(join(home, "agent"), { recursive: true });
		writeFileSync(join(cwd, ".pi/settings.json"), "{}");
		writeFileSync(join(cwd, "child/AGENTS.md"), "Child instructions\n");
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: child-sample\ndescription: A test skill.\n---\nTest instructions.\n");

		await withPi(cwd, home, ["--approve"], async request => {
			const { commands } = await request("get_commands");
			const names = new Set(commands.map((command: { name: string }) => command.name));
			assert.ok(names.has("context"));
			assert.ok(names.has("copy-resume-cmd"));
			assert.ok(names.has("subagents"));
			for (const name of ["handoff", "verify"]) {
				assert.ok(commands.some((command: { name: string; source: string }) => command.name === name && command.source === "prompt"), `Missing prompt: ${name}`);
			}
			assert.ok(!names.has("skill:child-sample"));

			for (const message of ["/context", "/context inventory", "/copy-resume-cmd"]) {
				const result = await request("prompt", { message });
				assert.equal(result.disposition, "handled");
			}
			const { entries } = await request("get_entries");
			const [regular, inventory] = entries.filter((entry: { customType?: string }) => entry.customType === "context-report").map((entry: { data: any }) => entry.data);
			const tools = new Set(regular.tools.filter((tool: { active: boolean }) => tool.active).map((tool: { name: string }) => tool.name));
			for (const name of ["subagent", "subagent_result", "ask_user_question"]) assert.ok(tools.has(name), `Missing active tool: ${name}`);
			assert.equal(regular.lastInjection, undefined);
			assert.equal(regular.subdirectoryContextFiles, undefined);
			assert.equal(inventory.subdirectoryContextFiles.length, 1);
			assert.ok(inventory.subdirectoryContextFiles[0].path.endsWith("/child/AGENTS.md"));
		});

		writeFileSync(join(home, "agent/trust.json"), JSON.stringify({ [cwd]: false }));
		for (const [flags, expected] of [
			[["--child-skills"], false],
			[["--approve", "--child-skills"], true],
			[["--approve", "--child-skills", "--no-skills"], false],
		] as const) {
			await withPi(cwd, home, [...flags], async request => {
				const { commands } = await request("get_commands");
				assert.equal(commands.some((command: { name: string }) => command.name === "skill:child-sample"), expected, flags.join(" "));
			});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import askUserQuestionExtension from "./index.ts";
import {
	CHAT_LABEL,
	DONE_LABEL,
	MAX_QUESTIONS,
	OTHER_LABEL,
	askMulti,
	askQuestions,
	askSingle,
	formatAnswers,
	shouldRegisterQuestionTool,
	validateQuestions,
	type Question,
	type QuestionUi,
} from "./core.ts";

type SelectResponder = (choices: string[]) => string | undefined;

type RegisteredTool = {
	parameters: any;
	execute: (...args: any[]) => Promise<unknown>;
};

function extensionHarness() {
	let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
	let tool: RegisteredTool | undefined;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: any) => void) {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool(definition: RegisteredTool) {
			tool = definition;
		},
	};
	askUserQuestionExtension(pi as any);
	return {
		start(ctx: any) {
			if (!sessionStart) throw new Error("session_start handler was not registered");
			sessionStart({}, ctx);
		},
		get tool() {
			return tool;
		},
	};
}

class FakeUi implements QuestionUi {
	readonly selectCalls: Array<{ title: string; choices: string[]; signal?: AbortSignal }> = [];
	readonly inputCalls: Array<{ title: string; placeholder?: string; signal?: AbortSignal }> = [];
	private readonly selectResponders: SelectResponder[];
	private readonly inputResponses: Array<string | undefined>;

	constructor(selectResponders: SelectResponder[], inputResponses: Array<string | undefined> = []) {
		this.selectResponders = [...selectResponders];
		this.inputResponses = [...inputResponses];
	}

	async select(title: string, choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined> {
		this.selectCalls.push({ title, choices, signal: options?.signal });
		const responder = this.selectResponders.shift();
		if (!responder) throw new Error("Unexpected select call");
		return responder(choices);
	}

	async input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined> {
		this.inputCalls.push({ title, placeholder, signal: options?.signal });
		if (!this.inputResponses.length) throw new Error("Unexpected input call");
		return this.inputResponses.shift();
	}
}

function question(overrides: Partial<Question> = {}): Question {
	return {
		question: "Which database?",
		options: [
			{ label: "Postgres", description: "Relational" },
			{ label: "SQLite", description: "Embedded" },
		],
		...overrides,
	};
}

test("question validation enforces bounds and exact recommendations", () => {
	assert.equal(validateQuestions([]), "no_questions");
	assert.equal(validateQuestions(Array.from({ length: MAX_QUESTIONS + 1 }, (_, index) => question({ question: `Question ${index}?` }))), "too_many_questions");
	assert.equal(validateQuestions([question({ recommended: "Missing" })]), "invalid_recommended_option");
	assert.equal(validateQuestions([question({ options: [{ label: " SQLite " }], recommended: "SQLite" })]), "option_label_has_surrounding_whitespace");
	assert.equal(validateQuestions([question({ recommended: "SQLite" })]), undefined);
});

test("single select places the recommended option first and preserves its label", async () => {
	const controller = new AbortController();
	const ui = new FakeUi([choices => choices[0]]);
	const answer = await askSingle(question({ recommended: "SQLite" }), 0, 1, ui, controller.signal);

	assert.equal(answer.kind, "option");
	assert.equal(answer.answer, "SQLite");
	assert.match(ui.selectCalls[0].choices[0], /SQLite.*Recommended/);
	assert.equal(ui.selectCalls[0].signal, controller.signal);
});

test("single select cancellation is explicit", async () => {
	const answer = await askSingle(question(), 0, 1, new FakeUi([() => undefined]));
	assert.equal(answer.kind, "cancelled");
});

test("chat redirect stops a dependent question batch", async () => {
	const ui = new FakeUi([choices => choices.find(choice => choice === CHAT_LABEL)]);
	const answers = await askQuestions([
		question(),
		question({ question: "Which cache?" }),
	], ui);

	assert.equal(answers.length, 1);
	assert.equal(answers[0].kind, "chat");
	assert.equal(ui.selectCalls.length, 1);
});

test("multi-select toggles options, accepts custom text, and submits once", async () => {
	const controller = new AbortController();
	const ui = new FakeUi([
		choices => choices.find(choice => choice.includes("SQLite")),
		choices => choices.find(choice => choice === OTHER_LABEL),
		choices => choices.find(choice => choice === DONE_LABEL),
	], ["DuckDB"]);
	const answer = await askMulti(question({ multiSelect: true, recommended: "SQLite" }), 0, 1, ui, controller.signal);

	assert.equal(answer.kind, "multi");
	assert.deepEqual(answer.selected, ["SQLite", "DuckDB"]);
	assert.equal(ui.selectCalls.length, 3);
	assert.equal(ui.inputCalls[0].signal, controller.signal);
});

test("multi-select can toggle an option off before submission", async () => {
	const ui = new FakeUi([
		choices => choices.find(choice => choice.includes("Postgres")),
		choices => choices.find(choice => choice.includes("Postgres")),
		choices => choices.find(choice => choice === DONE_LABEL),
	]);
	const answer = await askMulti(question({ multiSelect: true, allowOther: false }), 0, 1, ui);

	assert.deepEqual(answer.selected, []);
	assert.match(ui.selectCalls[1].choices.find(choice => choice.includes("Postgres"))!, /^☑/);
});

test("answer formatting preserves arrays and punctuation unambiguously", () => {
	const formatted = formatAnswers([{
		questionIndex: 0,
		question: "Choose values",
		kind: "multi",
		answer: null,
		selected: ["one, two", "three"],
	}]);
	const parsed = JSON.parse(formatted);
	assert.deepEqual(parsed.answers[0].selected, ["one, two", "three"]);
});

test("question tool registration follows UI availability", () => {
	assert.equal(shouldRegisterQuestionTool(true), true);
	assert.equal(shouldRegisterQuestionTool(false), false);
	for (const [mode, hasUI, expected] of [
		["tui", true, true],
		["rpc", true, true],
		["json", false, false],
		["print", false, false],
	] as const) {
		const harness = extensionHarness();
		harness.start({ mode, hasUI });
		assert.equal(!!harness.tool, expected, `${mode} registration`);
	}
});

test("registered tool aborts and throws when the user cancels", async () => {
	const harness = extensionHarness();
	const ui = new FakeUi([() => undefined]);
	let abortCalls = 0;
	const ctx = { hasUI: true, mode: "tui", ui, abort: () => { abortCalls++; } };
	harness.start(ctx);
	assert.ok(harness.tool);

	await assert.rejects(
		harness.tool.execute("call", { questions: [question()] }, new AbortController().signal, undefined, ctx),
		/active agent turn was aborted/,
	);
	assert.equal(abortCalls, 1);
});

test("registered tool schema enforces question and option bounds", () => {
	const harness = extensionHarness();
	harness.start({ mode: "tui", hasUI: true });
	assert.ok(harness.tool);
	const questions = harness.tool.parameters.properties.questions;
	assert.equal(questions.minItems, 1);
	assert.equal(questions.maxItems, 4);
	assert.equal(questions.items.properties.options.minItems, 1);
	assert.equal(questions.items.properties.options.maxItems, 6);
});

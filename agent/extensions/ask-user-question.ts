import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "ask_user_question";
const OTHER_LABEL = "Other (type your own answer)";
const CHAT_LABEL = "Chat about this instead";
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

type QuestionOption = {
	label: string;
	description?: string;
};

type Question = {
	question: string;
	header?: string;
	options: QuestionOption[];
	allowOther?: boolean;
	allowChat?: boolean;
	multiSelect?: boolean;
};

type Answer = {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "chat" | "multi" | "cancelled";
	answer: string | null;
	selected?: string[];
};

function optionLabel(option: QuestionOption): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

function findOptionByRenderedLabel(question: Question, rendered: string): QuestionOption | undefined {
	return question.options.find((option) => optionLabel(option) === rendered);
}

function validateQuestions(questions: Question[]): string | undefined {
	if (questions.length === 0) return "no_questions";
	if (questions.length > MAX_QUESTIONS) return "too_many_questions";
	const seenQuestions = new Set<string>();
	for (const question of questions) {
		const text = question.question.trim();
		if (!text) return "empty_question";
		if (seenQuestions.has(text)) return "duplicate_question";
		seenQuestions.add(text);
		if (!question.options.length) return "empty_options";
		if (question.options.length > MAX_OPTIONS) return "too_many_options";
		const labels = new Set<string>();
		for (const option of question.options) {
			const label = option.label.trim();
			if (!label) return "empty_option_label";
			if (label === OTHER_LABEL || label === CHAT_LABEL) return "reserved_label";
			if (labels.has(label)) return "duplicate_option_label";
			labels.add(label);
		}
	}
	return undefined;
}

function formatAnswers(answers: Answer[]): string {
	return answers.map((answer) => {
		if (answer.kind === "multi") return `Q${answer.questionIndex + 1}: ${answer.selected?.join(", ") || "(none selected)"}`;
		if (answer.kind === "cancelled") return `Q${answer.questionIndex + 1}: cancelled`;
		return `Q${answer.questionIndex + 1}: ${answer.answer ?? "(no answer)"}`;
	}).join("\n");
}

async function askSingle(question: Question, index: number, ctx: any): Promise<Answer> {
	const choices = question.options.map(optionLabel);
	if (question.allowOther !== false) choices.push(OTHER_LABEL);
	if (question.allowChat !== false) choices.push(CHAT_LABEL);

	const title = question.header ? `${question.header}: ${question.question}` : question.question;
	const selected = await ctx.ui.select(title, choices);
	if (!selected) return { questionIndex: index, question: question.question, kind: "cancelled", answer: null };
	if (selected === CHAT_LABEL) return { questionIndex: index, question: question.question, kind: "chat", answer: CHAT_LABEL };
	if (selected === OTHER_LABEL) {
		const custom = await ctx.ui.input(title, "Type your answer");
		if (custom === undefined) return { questionIndex: index, question: question.question, kind: "cancelled", answer: null };
		return { questionIndex: index, question: question.question, kind: "custom", answer: custom.trim() || null };
	}
	const option = findOptionByRenderedLabel(question, selected);
	return { questionIndex: index, question: question.question, kind: "option", answer: option?.label ?? selected };
}

async function askMulti(question: Question, index: number, ctx: any): Promise<Answer> {
	const selected: string[] = [];
	for (const option of question.options) {
		const ok = await ctx.ui.confirm(question.question, `${option.label}${option.description ? `\n\n${option.description}` : ""}`);
		if (ok) selected.push(option.label);
	}
	if (question.allowOther !== false) {
		const addOther = await ctx.ui.confirm(question.question, "Add another free-text answer?");
		if (addOther) {
			const custom = await ctx.ui.input(question.question, "Type another answer");
			if (custom === undefined) return { questionIndex: index, question: question.question, kind: "cancelled", answer: null };
			if (custom.trim()) selected.push(custom.trim());
		}
	}
	return { questionIndex: index, question: question.question, kind: "multi", answer: selected.join(", ") || null, selected };
}

export default function askUserQuestion(pi: ExtensionAPI) {
	const OptionSchema = Type.Object({
		label: Type.String({ description: "Short option label, ideally 1-5 words." }),
		description: Type.Optional(Type.String({ description: "Optional explanation or trade-off for this option." })),
	});
	const QuestionSchema = Type.Object({
		question: Type.String({ description: "Question to ask the user. Prefer a concrete question ending in '?'." }),
		header: Type.Optional(Type.String({ description: "Short context label for the question." })),
		options: Type.Array(OptionSchema, { description: "Concrete choices for the user." }),
		allowOther: Type.Optional(Type.Boolean({ description: "Include a free-text Other option. Defaults to true." })),
		allowChat: Type.Optional(Type.Boolean({ description: "Include a 'chat about this' option. Defaults to true for single-select questions." })),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Implemented as a short yes/no pass over each option." })),
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User Question",
		description: "Ask the user one or more structured clarifying questions with concrete options instead of guessing.",
		promptSnippet: "Ask the user structured clarifying questions with selectable options.",
		promptGuidelines: [
			"Use ask_user_question when a requirement is ambiguous and guessing would risk wasted work or the wrong design.",
			"Do not use ask_user_question for trivial preferences or questions that can be answered by inspecting the codebase.",
			"Provide concrete, mutually distinct options and include the trade-off in each option description.",
			"Batch closely related clarifying questions into one ask_user_question call instead of asking serially.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			questions: Type.Array(QuestionSchema, { description: "One to four questions to ask." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("UI not available; cannot ask user a question.");

			const questions = params.questions as Question[];
			const error = validateQuestions(questions);
			if (error) throw new Error(`Invalid questions (${error}).`);

			const answers: Answer[] = [];
			for (const [index, question] of questions.entries()) {
				const answer = question.multiSelect ? await askMulti(question, index, ctx) : await askSingle(question, index, ctx);
				answers.push(answer);
				if (answer.kind === "cancelled") break;
			}

			const cancelled = answers.some((answer) => answer.kind === "cancelled");
			return {
				content: [{ type: "text", text: cancelled ? `User cancelled one or more questions.\n${formatAnswers(answers)}` : `User answered:\n${formatAnswers(answers)}` }],
				details: { cancelled, answers },
			};
		},
	});
}

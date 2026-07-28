export const OTHER_LABEL = "Other (type your own answer)";
export const CHAT_LABEL = "Chat about this instead";
export const DONE_LABEL = "Done — submit selections";
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 6;

export type QuestionOption = {
	label: string;
	description?: string;
};

export type Question = {
	question: string;
	header?: string;
	options: QuestionOption[];
	recommended?: string;
	allowOther?: boolean;
	allowChat?: boolean;
	multiSelect?: boolean;
};

export type Answer = {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "chat" | "multi" | "cancelled";
	answer: string | null;
	selected?: string[];
};

export type QuestionUi = {
	select(title: string, choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined>;
	input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
};

type RenderedChoice = {
	text: string;
	kind: "option" | "other" | "chat" | "done" | "custom";
	optionIndex?: number;
	customIndex?: number;
};

function optionLabel(option: QuestionOption): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function orderedOptions(question: Question): Array<{ option: QuestionOption; index: number }> {
	const options = question.options.map((option, index) => ({ option, index }));
	if (!question.recommended) return options;
	return [
		...options.filter(({ option }) => option.label === question.recommended),
		...options.filter(({ option }) => option.label !== question.recommended),
	];
}

function titleFor(question: Question, index: number, total: number): string {
	const progress = total > 1 ? ` [${index + 1}/${total}]` : "";
	return question.header
		? `${question.header}${progress}: ${question.question}`
		: `${question.question}${progress}`;
}

function optionChoice(question: Question, option: QuestionOption, optionIndex: number, displayIndex: number, selected?: boolean): RenderedChoice {
	const check = selected === undefined ? "" : selected ? "☑ " : "☐ ";
	const recommended = option.label === question.recommended ? " (Recommended)" : "";
	return {
		text: `${check}${displayIndex + 1}. ${oneLine(optionLabel(option))}${recommended}`,
		kind: "option",
		optionIndex,
	};
}

function cancelled(question: Question, index: number): Answer {
	return { questionIndex: index, question: question.question, kind: "cancelled", answer: null };
}

export function validateQuestions(questions: Question[]): string | undefined {
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
			const label = option.label;
			if (!label.trim()) return "empty_option_label";
			if (label !== label.trim()) return "option_label_has_surrounding_whitespace";
			if ([OTHER_LABEL, CHAT_LABEL, DONE_LABEL].includes(label)) return "reserved_label";
			if (labels.has(label)) return "duplicate_option_label";
			labels.add(label);
		}
		if (question.recommended !== undefined && !labels.has(question.recommended)) return "invalid_recommended_option";
	}
	return undefined;
}

export async function askSingle(question: Question, index: number, total: number, ui: QuestionUi, signal?: AbortSignal): Promise<Answer> {
	const rendered = orderedOptions(question).map(({ option, index: optionIndex }, displayIndex) => optionChoice(question, option, optionIndex, displayIndex));
	if (question.allowOther !== false) rendered.push({ text: OTHER_LABEL, kind: "other" });
	if (question.allowChat !== false) rendered.push({ text: CHAT_LABEL, kind: "chat" });
	const byText = new Map(rendered.map(choice => [choice.text, choice]));
	const title = titleFor(question, index, total);
	const selected = await ui.select(title, rendered.map(choice => choice.text), { signal });
	if (selected === undefined) return cancelled(question, index);
	const choice = byText.get(selected);
	if (!choice) return cancelled(question, index);
	if (choice.kind === "chat") return { questionIndex: index, question: question.question, kind: "chat", answer: CHAT_LABEL };
	if (choice.kind === "other") {
		const custom = await ui.input(title, "Type your answer", { signal });
		if (custom === undefined) return cancelled(question, index);
		return { questionIndex: index, question: question.question, kind: "custom", answer: custom.trim() || null };
	}
	const option = question.options[choice.optionIndex!];
	return { questionIndex: index, question: question.question, kind: "option", answer: option.label };
}

export async function askMulti(question: Question, index: number, total: number, ui: QuestionUi, signal?: AbortSignal): Promise<Answer> {
	const selectedOptions = new Set<number>();
	const customAnswers: string[] = [];
	const title = titleFor(question, index, total);

	while (true) {
		const rendered: RenderedChoice[] = orderedOptions(question).map(({ option, index: optionIndex }, displayIndex) => {
			return optionChoice(question, option, optionIndex, displayIndex, selectedOptions.has(optionIndex));
		});
		for (const [customIndex, custom] of customAnswers.entries()) {
			rendered.push({ text: `☑ Other ${customIndex + 1}: ${oneLine(custom)}`, kind: "custom", customIndex });
		}
		if (question.allowOther !== false) rendered.push({ text: OTHER_LABEL, kind: "other" });
		if (question.allowChat === true) rendered.push({ text: CHAT_LABEL, kind: "chat" });
		rendered.push({ text: DONE_LABEL, kind: "done" });
		const byText = new Map(rendered.map(choice => [choice.text, choice]));
		const selected = await ui.select(title, rendered.map(choice => choice.text), { signal });
		if (selected === undefined) return cancelled(question, index);
		const choice = byText.get(selected);
		if (!choice) return cancelled(question, index);
		if (choice.kind === "done") {
			const answers = [
				...question.options.flatMap((option, optionIndex) => selectedOptions.has(optionIndex) ? [option.label] : []),
				...customAnswers,
			];
			return { questionIndex: index, question: question.question, kind: "multi", answer: null, selected: answers };
		}
		if (choice.kind === "chat") return { questionIndex: index, question: question.question, kind: "chat", answer: CHAT_LABEL };
		if (choice.kind === "option") {
			if (selectedOptions.has(choice.optionIndex!)) selectedOptions.delete(choice.optionIndex!);
			else selectedOptions.add(choice.optionIndex!);
			continue;
		}
		if (choice.kind === "custom") {
			customAnswers.splice(choice.customIndex!, 1);
			continue;
		}
		const custom = await ui.input(title, "Type another answer", { signal });
		if (custom === undefined) return cancelled(question, index);
		const value = custom.trim();
		if (value && !customAnswers.includes(value)) customAnswers.push(value);
	}
}

export async function askQuestions(questions: Question[], ui: QuestionUi, signal?: AbortSignal): Promise<Answer[]> {
	const answers: Answer[] = [];
	for (const [index, question] of questions.entries()) {
		const answer = question.multiSelect
			? await askMulti(question, index, questions.length, ui, signal)
			: await askSingle(question, index, questions.length, ui, signal);
		answers.push(answer);
		if (answer.kind === "cancelled" || answer.kind === "chat") break;
	}
	return answers;
}

export function formatAnswers(answers: Answer[]): string {
	return JSON.stringify({ answers }, null, 2);
}

export function shouldRegisterQuestionTool(hasUI: boolean): boolean {
	return hasUI;
}

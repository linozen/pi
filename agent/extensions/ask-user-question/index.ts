import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	askQuestions,
	formatAnswers,
	shouldRegisterQuestionTool,
	validateQuestions,
	type Question,
	type QuestionUi,
} from "./core.ts";

const TOOL_NAME = "ask_user_question";

export default function askUserQuestion(pi: ExtensionAPI) {
	const OptionSchema = {
		type: "object",
		properties: {
			label: { type: "string", minLength: 1, description: "Short option label, ideally 1-5 words." },
			description: { type: "string", description: "Optional explanation or trade-off for this option." },
		},
		required: ["label"],
		additionalProperties: false,
	} as const;
	const QuestionSchema = {
		type: "object",
		properties: {
			question: { type: "string", minLength: 1, description: "Question to ask the user. Prefer a concrete question ending in '?'." },
			header: { type: "string", description: "Short context label for the question." },
			options: {
				type: "array",
				items: OptionSchema,
				description: "Concrete choices for the user.",
				minItems: 1,
				maxItems: MAX_OPTIONS,
			},
			recommended: { type: "string", description: "Exact label of the recommended option. The label must appear in options." },
			allowOther: { type: "boolean", description: "Include a free-text Other option. Defaults to true." },
			allowChat: { type: "boolean", description: "Include a 'chat about this' option. Defaults to true for single-select and false for multi-select questions." },
			multiSelect: { type: "boolean", description: "Allow repeated toggling of multiple options before submitting with Done." },
		},
		required: ["question", "options"],
		additionalProperties: false,
	} as const;

	let registered = false;
	pi.on("session_start", (_event, ctx) => {
		if (registered || !shouldRegisterQuestionTool(ctx.hasUI)) return;
		registered = true;
		pi.registerTool({
			name: TOOL_NAME,
			label: "Ask User Question",
			description: "Ask the user one or more structured clarifying questions with concrete options instead of guessing.",
			promptSnippet: "Ask the user structured clarifying questions with selectable options.",
			promptGuidelines: [
				"Use ask_user_question when a requirement is ambiguous and guessing would risk wasted work or the wrong design.",
				"Do not use ask_user_question for trivial preferences or questions that can be answered by inspecting the codebase.",
				"Provide concrete, mutually distinct options, mark the recommended option, and include the trade-off in each description.",
				"Ask dependent design decisions one at a time so later options can incorporate earlier answers. Batch only independent questions that can be answered in any order.",
			],
			executionMode: "sequential",
			parameters: {
				type: "object",
				properties: {
					questions: {
						type: "array",
						items: QuestionSchema,
						description: "One to four questions to ask.",
						minItems: 1,
						maxItems: MAX_QUESTIONS,
					},
				},
				required: ["questions"],
				additionalProperties: false,
			},
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (!ctx.hasUI) throw new Error("UI not available; cannot ask user a question.");
				const questions = params.questions as Question[];
				const validationError = validateQuestions(questions);
				if (validationError) throw new Error(`Invalid questions (${validationError}).`);

				const answers = await askQuestions(questions, ctx.ui as QuestionUi, signal);
				const lastAnswer = answers.at(-1);
				if (lastAnswer?.kind === "cancelled") {
					ctx.abort();
					throw new Error("User cancelled the question; the active agent turn was aborted.");
				}
				if (lastAnswer?.kind === "chat") {
					return {
						content: [{ type: "text", text: `User requested discussion instead of selecting an answer.\n${formatAnswers(answers)}` }],
						details: { cancelled: false, chatRedirect: true, answers },
					};
				}
				return {
					content: [{ type: "text", text: `User answered:\n${formatAnswers(answers)}` }],
					details: { cancelled: false, chatRedirect: false, answers },
				};
			},
		});
	});
}

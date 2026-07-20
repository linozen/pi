import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	for (const command of ["exit", "exti", "q", "bye"]) {
		pi.registerCommand(command, {
			description: "Alias for /quit",
			handler: async (_args, ctx) => {
				ctx.shutdown();
			},
		});
	}
}

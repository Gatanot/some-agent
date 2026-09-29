import { estimateTokens } from "@gatanot/orrery";

type ContextMessage = Parameters<typeof estimateTokens>[0];

export interface ContextPart {
	key: "config" | "user" | "tools" | "assistant";
	tokens: number;
}

/**
 * Estimate how the current context window is split between configuration, user input, tool
 * results, and model output.
 *
 * Message tokens come from pi's chars/4 estimate. When the authoritative context total is known,
 * `config` absorbs the remainder (system prompt, AGENTS.md, and tool schemas). If the message
 * estimates overshoot the real total, they are scaled down to fit. Without a total (for example
 * right after compaction) `config` falls back to an estimate of the system prompt text.
 */
export function contextBreakdown(
	messages: readonly ContextMessage[],
	systemPrompt: string,
	total: number | null | undefined,
): ContextPart[] {
	let user = 0;
	let tools = 0;
	let assistant = 0;
	for (const message of messages) {
		const tokens = estimateTokens(message);
		if (tokens === 0) continue;
		switch (message.role) {
			case "user":
				user += tokens;
				break;
			case "toolResult":
			case "bashExecution":
			case "custom":
				tools += tokens;
				break;
			case "assistant":
			case "branchSummary":
			case "compactionSummary":
				assistant += tokens;
				break;
		}
	}

	let config: number;
	if (typeof total === "number" && total > 0) {
		const messageTotal = user + tools + assistant;
		if (messageTotal > total) {
			const scale = total / messageTotal;
			user = Math.floor(user * scale);
			tools = Math.floor(tools * scale);
			assistant = Math.floor(assistant * scale);
		}
		config = Math.max(0, total - user - tools - assistant);
	} else {
		config = Math.ceil(systemPrompt.length / 4);
	}

	return [
		{ key: "config", tokens: config },
		{ key: "user", tokens: user },
		{ key: "tools", tokens: tools },
		{ key: "assistant", tokens: assistant },
	];
}

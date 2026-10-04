import { estimateTokens } from "@gatanot/orrery/web-api";

type ContextMessage = Parameters<typeof estimateTokens>[0];

export interface ContextPart {
	key: "config" | "user" | "tools" | "assistant";
	tokens: number;
}

interface TokenBuckets {
	user: number;
	tools: number;
	assistant: number;
}

interface MeasuredAssistant {
	/** Full prompt the provider saw, from `input + cacheRead + cacheWrite`. */
	prompt: number;
	output: number;
	/** chars/4 fallback when the provider-reported output is implausible. */
	estimate: number;
}

/**
 * Provider usage for an assistant response that can anchor prompt deltas. Failed and aborted
 * responses keep the chars/4 estimate because their output may be partial.
 */
function measuredAssistant(message: ContextMessage): MeasuredAssistant | undefined {
	if (message.role !== "assistant") return undefined;
	const { stopReason } = message;
	if (stopReason === "aborted" || stopReason === "error") return undefined;
	const usage = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } })
		.usage;
	if (!usage) return undefined;
	// Cached and uncached input are disjoint parts of the full prompt for every provider.
	const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (prompt <= 0) return undefined;
	return { prompt, output: usage.output ?? 0, estimate: estimateTokens(message) };
}

function addEstimate(buckets: TokenBuckets, message: ContextMessage): void {
	const tokens = estimateTokens(message);
	if (tokens === 0) return;
	switch (message.role) {
		case "user":
			buckets.user += tokens;
			break;
		case "toolResult":
		case "bashExecution":
		case "custom":
			buckets.tools += tokens;
			break;
		case "assistant":
		case "branchSummary":
		case "compactionSummary":
			buckets.assistant += tokens;
			break;
	}
}

function addBuckets(target: TokenBuckets, source: TokenBuckets): void {
	target.user += source.user;
	target.tools += source.tools;
	target.assistant += source.assistant;
}

function resetBuckets(buckets: TokenBuckets): void {
	buckets.user = 0;
	buckets.tools = 0;
	buckets.assistant = 0;
}

/** Split `tokens` across the buckets in proportion to their chars/4 weights. */
function distribute(target: TokenBuckets, weights: TokenBuckets, tokens: number): void {
	const weight = weights.user + weights.tools + weights.assistant;
	if (weight <= 0 || tokens <= 0) return;
	target.user += Math.round((weights.user / weight) * tokens);
	target.tools += Math.round((weights.tools / weight) * tokens);
	target.assistant += Math.round((weights.assistant / weight) * tokens);
}

/**
 * Attribute message tokens using provider prompt deltas.
 *
 * Each measured response reports the full prompt it saw and its generated output. The prompt growth
 * between two responses is the replayed previous assistant message plus the user/tool messages added
 * in between, so `delta - previousOutput` is the exact token count of the new user/tool content. It
 * is split between the two buckets by chars/4 weights, which keeps per-message tokenizer error out
 * of `config`: the total-minus-buckets remainder then holds only the first prompt's estimate error
 * (system prompt, AGENTS.md, and tool schemas) instead of growing with every turn.
 */
function attributeByDeltas(messages: readonly ContextMessage[], parts: TokenBuckets): void {
	const interval: TokenBuckets = { user: 0, tools: 0, assistant: 0 };
	let previous: MeasuredAssistant | undefined;

	for (const message of messages) {
		const measured = measuredAssistant(message);
		if (!measured) {
			addEstimate(interval, message);
			continue;
		}
		if (!previous) {
			// Messages before the first measured response stay estimated; the remainder pins them.
			addBuckets(parts, interval);
		} else {
			const delta = measured.prompt - previous.prompt;
			// A response cannot occupy more context than the prompt growth after it. Some gateways
			// count hidden reasoning in `output`, which breaks that bound; use the text estimate then.
			const footprint = previous.output > 0 && previous.output <= delta ? previous.output : previous.estimate;
			parts.assistant += footprint;
			const content = delta - footprint;
			if (content >= 0) distribute(parts, interval, content);
			else addBuckets(parts, interval);
		}
		resetBuckets(interval);
		previous = measured;
	}

	if (previous) parts.assistant += previous.output > 0 ? previous.output : previous.estimate;
	// Trailing messages after the last measured response cannot be delta-attributed.
	addBuckets(parts, interval);
}

/**
 * Estimate how the current context window is split between configuration, user input, tool results,
 * and model output.
 *
 * Assistant output uses the provider-reported token count, and user/tool content is derived from
 * real prompt deltas, so both are exact when usage is available. Config is the total minus the
 * buckets: system prompt, AGENTS.md, and tool schemas, plus any first-prompt estimation error. If
 * the buckets overshoot the real total they are scaled down to fit. Without a total (for example
 * right after compaction) everything falls back to the chars/4 estimate and config to the system
 * prompt text.
 */
export function contextBreakdown(
	messages: readonly ContextMessage[],
	systemPrompt: string,
	total: number | null | undefined,
): ContextPart[] {
	const hasTotal = typeof total === "number" && total > 0;
	const parts: TokenBuckets = { user: 0, tools: 0, assistant: 0 };
	if (hasTotal) {
		attributeByDeltas(messages, parts);
	} else {
		for (const message of messages) addEstimate(parts, message);
	}

	let config: number;
	if (hasTotal) {
		const messageTotal = parts.user + parts.tools + parts.assistant;
		if (messageTotal > total) {
			const scale = total / messageTotal;
			parts.user = Math.floor(parts.user * scale);
			parts.tools = Math.floor(parts.tools * scale);
			parts.assistant = Math.floor(parts.assistant * scale);
		}
		config = Math.max(0, total - parts.user - parts.tools - parts.assistant);
	} else {
		config = Math.ceil(systemPrompt.length / 4);
	}

	return [
		{ key: "config", tokens: config },
		{ key: "user", tokens: parts.user },
		{ key: "tools", tokens: parts.tools },
		{ key: "assistant", tokens: parts.assistant },
	];
}

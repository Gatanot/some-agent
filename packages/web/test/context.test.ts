import assert from "node:assert/strict";
import test from "node:test";
import { contextBreakdown } from "../src/context.ts";

type ContextMessage = Parameters<typeof contextBreakdown>[0][number];

function message(value: unknown): ContextMessage {
	return value as ContextMessage;
}

function tokens(parts: ReturnType<typeof contextBreakdown>): Record<string, number> {
	return Object.fromEntries(parts.map((part) => [part.key, part.tokens]));
}

test("splits messages into context buckets and puts the remainder in config", () => {
	const parts = contextBreakdown(
		[
			message({ role: "user", content: "u".repeat(8) }),
			message({ role: "assistant", content: [{ type: "text", text: "a".repeat(40) }] }),
			message({ role: "toolResult", content: "t".repeat(20) }),
			message({ role: "bashExecution", command: "ls", output: "o".repeat(35) }),
		],
		"",
		100,
	);

	assert.deepEqual(tokens(parts), { config: 73, user: 2, tools: 15, assistant: 10 });
});

test("uses provider-reported output tokens for assistant messages", () => {
	const parts = contextBreakdown(
		[
			message({ role: "user", content: "u".repeat(8) }),
			// chars/4 would report 40000 tokens for this text; the provider said 1200.
			message({
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(160_000) }],
				usage: { input: 10, output: 1200, cacheRead: 0, cacheWrite: 0, totalTokens: 1210, cost: { total: 0 } },
			}),
		],
		"",
		5000,
	);

	assert.deepEqual(tokens(parts), { config: 3798, user: 2, tools: 0, assistant: 1200 });
});

test("falls back to the chars/4 estimate when assistant usage is missing or zero", () => {
	const parts = contextBreakdown(
		[
			message({
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(40) }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			}),
		],
		"",
		100,
	);

	assert.deepEqual(tokens(parts), { config: 90, user: 0, tools: 0, assistant: 10 });
});

test("derives user and tool tokens from prompt deltas", () => {
	const parts = contextBreakdown(
		[
			message({ role: "user", content: "u".repeat(40) }),
			message({
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(40) }],
				stopReason: "toolUse",
				usage: { input: 110, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 130, cost: { total: 0 } },
			}),
			message({ role: "toolResult", content: "t".repeat(80) }),
			message({
				role: "assistant",
				content: [{ type: "text", text: "b".repeat(20) }],
				stopReason: "stop",
				usage: { input: 140, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 145, cost: { total: 0 } },
			}),
		],
		"",
		145,
	);

	// Prompt grew 30 (140 - 110) while the first response generated 20, so 10 tool tokens came from
	// the result. Config stays at the first prompt's remainder (110 - 10 user estimate).
	assert.deepEqual(tokens(parts), { config: 100, user: 10, tools: 10, assistant: 25 });
});

test("falls back to the text estimate when output exceeds prompt growth", () => {
	const parts = contextBreakdown(
		[
			message({ role: "user", content: "u".repeat(40) }),
			message({
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(40) }],
				stopReason: "toolUse",
				// Some gateways count hidden reasoning in `output`; the prompt only grew 30 tokens.
				usage: { input: 110, output: 9999, cacheRead: 0, cacheWrite: 0, totalTokens: 10109, cost: { total: 0 } },
			}),
			message({ role: "toolResult", content: "t".repeat(80) }),
			message({
				role: "assistant",
				content: [{ type: "text", text: "b".repeat(20) }],
				stopReason: "stop",
				usage: { input: 140, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 145, cost: { total: 0 } },
			}),
		],
		"",
		145,
	);

	assert.deepEqual(tokens(parts), { config: 100, user: 10, tools: 20, assistant: 15 });
});

test("uses the chars/4 estimate without a context total even when usage is present", () => {
	const parts = contextBreakdown(
		[
			message({ role: "user", content: "u".repeat(40) }),
			message({
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(40) }],
				usage: { input: 110, output: 9999, cacheRead: 0, cacheWrite: 0, totalTokens: 10109, cost: { total: 0 } },
			}),
		],
		"s".repeat(40),
		null,
	);

	assert.deepEqual(tokens(parts), { config: 10, user: 10, tools: 0, assistant: 10 });
});

test("scales message buckets down when they overshoot the real context total", () => {
	const parts = contextBreakdown(
		[
			message({ role: "user", content: "u".repeat(400) }),
			message({ role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] }),
		],
		"",
		100,
	);

	const totals = tokens(parts);
	assert.equal(totals.user, 50);
	assert.equal(totals.assistant, 50);
	assert.equal(totals.tools, 0);
	assert.equal(totals.config, 0);
	assert.equal(
		parts.reduce((sum, part) => sum + part.tokens, 0),
		100,
	);
});

test("falls back to the system prompt estimate when the context total is unknown", () => {
	const parts = contextBreakdown([message({ role: "user", content: "u".repeat(8) })], "s".repeat(40), null);

	assert.deepEqual(tokens(parts), { config: 10, user: 2, tools: 0, assistant: 0 });
});

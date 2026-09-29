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

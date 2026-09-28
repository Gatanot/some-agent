import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@gatanot/orrery";
import { localDateKey, summarizeUsage } from "../src/usage.ts";

interface UsageInput {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function usageRecord(usage: UsageInput) {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

function assistantEntry(
	id: string,
	model: string,
	timestamp: number,
	usage: UsageInput,
	responseModel?: string,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "prov",
			model,
			...(responseModel ? { responseModel } : {}),
			usage: usageRecord(usage),
			stopReason: "stop",
			timestamp,
		},
	} as unknown as SessionEntry;
}

function summaryEntry(id: string, timestamp: number, usage: UsageInput): SessionEntry {
	return {
		type: "branch_summary",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		fromId: "root",
		summary: "summary",
		usage: usageRecord(usage),
	} as unknown as SessionEntry;
}

const day1 = new Date(2026, 8, 20, 12, 0, 0).getTime();
const day2 = new Date(2026, 8, 21, 12, 0, 0).getTime();

test("groups usage by model and omits unused models", () => {
	const summary = summarizeUsage([
		assistantEntry("a", "m1", day1, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.02 }),
		assistantEntry("b", "m1", day1, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 }),
		assistantEntry("c", "m2", day1, { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }),
		assistantEntry("d", "m3", day1, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
	]);

	assert.deepEqual(
		summary.models.map((model) => [model.key, model.tokens]),
		[
			["prov/m1", 20],
			["prov/m2", 5],
		],
	);
	assert.equal(summary.models[0]?.cost.toFixed(3), "0.030");
});

test("attributes usage via responseModel when present", () => {
	const summary = summarizeUsage([
		assistantEntry("a", "auto", day1, { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, "resolved"),
	]);

	assert.deepEqual(
		summary.models.map((model) => model.key),
		["prov/resolved"],
	);
});

test("groups usage by local day in ascending order", () => {
	const summary = summarizeUsage([
		assistantEntry("a", "m1", day2, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
		assistantEntry("b", "m1", day1, { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
		assistantEntry("c", "m1", day1, { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
	]);

	assert.deepEqual(
		summary.daily.map((day) => [day.date, day.tokens]),
		[
			[localDateKey(new Date(day1)), 5],
			[localDateKey(new Date(day2)), 5],
		],
	);
});

test("filters entries older than the window", () => {
	const summary = summarizeUsage(
		[
			assistantEntry("a", "m1", day1, { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
			assistantEntry("b", "m1", day2, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
		],
		day2,
	);

	assert.deepEqual(
		summary.models.map((model) => model.tokens),
		[5],
	);
	assert.deepEqual(
		summary.daily.map((day) => day.date),
		[localDateKey(new Date(day2))],
	);
});

test("buckets summary usage under Tools/summaries", () => {
	const summary = summarizeUsage([
		summaryEntry("a", day1, { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.05 }),
	]);

	assert.deepEqual(summary.models, [{ key: "Tools/summaries", tokens: 8, cost: 0.05 }]);
});

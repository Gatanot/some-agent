import assert from "node:assert/strict";
import test from "node:test";
import { snapshotToAppState } from "../src/live.ts";
import type { WebSnapshot } from "../src/protocol.ts";

function snapshot(overrides: Partial<WebSnapshot> = {}): WebSnapshot {
	return {
		protocolVersion: 1,
		sequence: 4,
		ready: true,
		cwd: "/tmp/project",
		prompting: false,
		phase: "idle",
		messages: [],
		pendingToolCalls: [],
		toolExecutions: [],
		git: { state: "unavailable", files: [] },
		model: { provider: "test", id: "model" },
		models: [{ provider: "test", id: "model", name: "Test Model" }],
		thinkingLevels: ["off", "medium"],
		thinkingLevel: "medium",
		...overrides,
	};
}

test("maps assistant thinking and completed tool results into timeline messages", () => {
	const state = snapshotToAppState(
		snapshot({
			messages: [
				{ role: "user", content: "检查 parser", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "先定位测试文件" },
						{ type: "text", text: "我先检查测试。" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/parser.ts" } },
					],
					usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, total: 18 },
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "export function parse() {}" }],
					isError: false,
					timestamp: 3,
				},
			],
		}),
		"connected",
	);

	assert.equal(state.phase, "idle");
	assert.equal(state.messages.length, 3);
	assert.equal(state.messages[0]?.role, "user");
	assert.equal(state.messages[1]?.role, "assistant");
	assert.equal(state.messages[1]?.blocks?.[0]?.type, "thinking");
	assert.equal(state.messages[2]?.role, "tools");
	assert.equal(state.messages[2]?.tools?.[0]?.status, "done");
	assert.match(state.messages[2]?.tools?.[0]?.output as string, /parse/);
});

test("reads totalTokens from assistant usage for context statistics", () => {
	const state = snapshotToAppState(
		snapshot({ contextUsage: { tokens: 150, contextWindow: 1000, percent: 15 } }),
		"connected",
	);

	assert.equal(state.usage, "150 tokens");
});

test("requires an available selected model before prompting", () => {
	const value = snapshot({ models: [{ provider: "test", id: "model", name: "Test Model" }] });
	delete value.model;
	const state = snapshotToAppState(value, "connected");

	assert.equal(state.noModel, true);
	assert.equal(state.modelKey, "");
	assert.equal(state.models.length, 1);
	assert.equal(state.notice?.kind, "warning");
});

test("uses a persisted session name for the live timeline title", () => {
	const state = snapshotToAppState(
		snapshot({ sessionName: "Fix auth flow", messages: [{ role: "user", content: "ignored", timestamp: 1 }] }),
		"connected",
	);

	assert.equal(state.title, "Fix auth flow");
});

test("keeps streaming assistant and partial tool execution visible after refresh", () => {
	const state = snapshotToAppState(
		snapshot({
			phase: "streaming",
			prompting: true,
			pendingToolCalls: ["call-2"],
			toolExecutions: [
				{
					toolCallId: "call-2",
					toolName: "bash",
					args: { command: "npm run check" },
					status: "running",
					partialResult: { content: [{ type: "text", text: "checking packages..." }] },
				},
			],
			streamingMessage: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "等待检查结果" }],
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
				stopReason: "pending",
				timestamp: 4,
			},
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "npm run check" } }],
					usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
					stopReason: "toolUse",
					timestamp: 3,
				},
			],
		}),
		"connected",
	);

	assert.equal(state.phase, "running");
	assert.equal(state.phaseTone, "running");
	assert.equal(state.messages.at(-1)?.role, "assistant");
	assert.equal(state.messages.at(-1)?.label, "Orrery · 生成中");
	const toolMessage = state.messages.find((message) => message.role === "tools");
	assert.equal(toolMessage?.tools?.[0]?.status, "running");
	assert.match(toolMessage?.tools?.[0]?.output as string, /checking/);
});

test("renders edit results as diff lines", () => {
	const state = snapshotToAppState(
		snapshot({
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-9", name: "edit", arguments: { path: "src/a.ts" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-9",
					toolName: "edit",
					content: [{ type: "text", text: "Updated src/a.ts" }],
					details: { diff: "-  1 old\n+  1 new\n   2 keep" },
					isError: false,
					timestamp: 2,
				},
			],
		}),
		"connected",
	);

	const tool = state.messages.find((message) => message.role === "tools")?.tools?.[0];
	assert.equal(tool?.outputType, "diff");
	assert.deepEqual(tool?.output, [
		{ kind: "remove", text: "  1 old" },
		{ kind: "add", text: "  1 new" },
		{ kind: "context", text: "  2 keep" },
	]);
});

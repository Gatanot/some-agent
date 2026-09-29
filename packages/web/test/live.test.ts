import assert from "node:assert/strict";
import test from "node:test";
import { lastUserPromptText, snapshotToAppState } from "../src/live.ts";
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
	assert.equal(state.messages.at(-1)?.label, "Orrery · streaming");
	const toolMessage = state.messages.find((message) => message.role === "tools");
	assert.equal(toolMessage?.tools?.[0]?.status, "running");
	assert.match(toolMessage?.tools?.[0]?.output as string, /checking/);
});

test("surfaces images returned by tools instead of dropping them", () => {
	const state = snapshotToAppState(
		snapshot({
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-img", name: "read", arguments: { path: "shot.png" } }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-img",
					toolName: "read",
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 2,
				},
			],
		}),
		"connected",
	);

	const tool = state.messages.find((message) => message.role === "tools")?.tools?.[0];
	assert.deepEqual(tool?.images, [{ mimeType: "image/png", data: "aGVsbG8=" }]);
	assert.match(tool?.output as string, /Read image file/);
});

test("renders image content parts as image blocks", () => {
	const state = snapshotToAppState(
		snapshot({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "看这张图" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		}),
		"connected",
	);

	const image = state.messages[0]?.blocks?.find((block) => block.type === "image");
	assert.deepEqual(image, { type: "image", mimeType: "image/png", data: "aGVsbG8=" });
});

test("labels a running turn as Working and a failed turn as Error", () => {
	const running = snapshotToAppState(snapshot({ phase: "streaming", prompting: true }), "connected");
	assert.equal(running.phaseLabel, "Working");

	const failed = snapshotToAppState(
		snapshot({
			phase: "error",
			error: "provider failed",
			messages: [
				{ role: "user", content: "fail", timestamp: 1 },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed", timestamp: 2 },
			],
		}),
		"connected",
	);
	assert.equal(failed.phaseLabel, "Error");
});

test("shows a turn error at the end of the conversation", () => {
	const withMessageError = snapshotToAppState(
		snapshot({
			phase: "error",
			error: "provider failed",
			messages: [
				{ role: "user", content: "fail", timestamp: 1 },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed", timestamp: 2 },
			],
		}),
		"connected",
	);
	assert.equal(withMessageError.messages.at(-1)?.error, "provider failed");
	assert.equal(withMessageError.messages.at(-1)?.errorAction, "retry");
	assert.equal(withMessageError.notice, undefined);

	// A session-level error has no assistant message to attach to, so it is appended.
	const withoutMessageError = snapshotToAppState(
		snapshot({
			phase: "error",
			error: "session failed to start",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		}),
		"connected",
	);
	assert.equal(withoutMessageError.messages.at(-1)?.error, "session failed to start");
	assert.equal(withoutMessageError.messages.at(-1)?.errorAction, "retry");
	assert.equal(withoutMessageError.notice, undefined);
});

test("extracts the last user prompt so a failed turn can be retried", () => {
	const value = snapshot({
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
			{ role: "assistant", content: "reply", timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "second" }], timestamp: 3 },
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "boom", timestamp: 4 },
		],
	});
	assert.equal(lastUserPromptText(value), "second");
	assert.equal(lastUserPromptText(snapshot()), "");
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

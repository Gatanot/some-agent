import type { AgentMessage } from "@gatanot/orrery-agent-core";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@gatanot/orrery-ai";
import { describe, expect, it } from "vitest";
import type { ResourceLoader } from "../../src/index.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function findSubagentResult(harness: Harness): AgentMessage | undefined {
	return harness.session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
}

function childSystemText(context: TranscriptContext): string {
	return context.messages
		.filter((message) => message.role === "system")
		.map((message) => getMessageText(message))
		.join("\n\n");
}

function childToolNames(context: TranscriptContext): string[] {
	return context.messages.flatMap((message) =>
		message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
	);
}

describe("subagent", () => {
	it("runs a child with end_task and without subagent, and returns its report", async () => {
		const harness = await createHarness();
		try {
			let childContext: TranscriptContext | undefined;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { prompt: "Count the files" }), { stopReason: "toolUse" }),
				(context) => {
					childContext = context;
					return fauxAssistantMessage(fauxToolCall("end_task", { report: "3 files" }), {
						stopReason: "toolUse",
					});
				},
				fauxAssistantMessage("parent finished"),
			]);

			await harness.session.prompt("delegate");

			const result = findSubagentResult(harness);
			expect(result?.role).toBe("toolResult");
			if (result?.role !== "toolResult") throw new Error("missing subagent tool result");
			expect(result.isError).toBe(false);
			expect(getMessageText(result)).toBe("3 files");

			expect(childContext).toBeDefined();
			const toolNames = childToolNames(childContext!);
			expect(toolNames).toContain("end_task");
			expect(toolNames).not.toContain("subagent");

			const systemText = childSystemText(childContext!);
			expect(systemText).toContain("end_task");
			expect(systemText).toContain("subagent");
		} finally {
			harness.cleanup();
		}
	});

	it("returns the child's last assistant text when it does not call end_task", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { prompt: "Say something" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("child answer"),
				fauxAssistantMessage("parent finished"),
			]);

			await harness.session.prompt("delegate");

			const result = findSubagentResult(harness);
			if (result?.role !== "toolResult") throw new Error("missing subagent tool result");
			expect(result.isError).toBe(false);
			expect(getMessageText(result)).toBe("child answer");
		} finally {
			harness.cleanup();
		}
	});

	it("passes AGENTS.md context files to the child system prompt", async () => {
		const resourceLoader: ResourceLoader = {
			...createTestResourceLoader(),
			getAgentsFiles: () => ({
				agentsFiles: [{ path: "/project/AGENTS.md", content: "GLOBAL RULE: never foo" }],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		try {
			let childContext: TranscriptContext | undefined;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { prompt: "Do the thing" }), { stopReason: "toolUse" }),
				(context) => {
					childContext = context;
					return fauxAssistantMessage("done");
				},
				fauxAssistantMessage("parent finished"),
			]);

			await harness.session.prompt("delegate");

			expect(childSystemText(childContext!)).toContain("GLOBAL RULE: never foo");
		} finally {
			harness.cleanup();
		}
	});

	it("aborts the child when the parent run is aborted", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { prompt: "Long task" }), { stopReason: "toolUse" }),
				(_context, options) =>
					new Promise((resolve) => {
						const finish = () => resolve(fauxAssistantMessage("late"));
						if (options?.signal?.aborted) {
							finish();
							return;
						}
						options?.signal?.addEventListener("abort", finish, { once: true });
					}),
				fauxAssistantMessage("parent finished"),
			]);

			const promptPromise = harness.session.prompt("delegate");
			while (harness.faux.state.callCount < 2) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			await harness.session.abort();
			await promptPromise;

			const result = findSubagentResult(harness);
			if (result?.role !== "toolResult") throw new Error("missing subagent tool result");
			expect(result.isError).toBe(true);
			expect(getMessageText(result).toLowerCase()).toContain("aborted");
		} finally {
			harness.cleanup();
		}
	});

	it("fails the tool when the child exceeds the turn limit", async () => {
		const harness = await createHarness();
		try {
			const childTurns = Array.from({ length: 50 }, () =>
				fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { prompt: "Loop forever" }), { stopReason: "toolUse" }),
				...childTurns,
				fauxAssistantMessage("parent finished"),
			]);

			await harness.session.prompt("delegate");

			const result = findSubagentResult(harness);
			if (result?.role !== "toolResult") throw new Error("missing subagent tool result");
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toContain("turn limit");
		} finally {
			harness.cleanup();
		}
	});
});

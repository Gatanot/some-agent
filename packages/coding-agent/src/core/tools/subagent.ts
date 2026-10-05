/**
 * Subagent tool.
 *
 * Runs a child agent in-process with the parent's active tools minus `subagent` plus
 * `end_task`. The child reuses the parent's model, stream function, tool hooks, system
 * prompt sources (including AGENTS.md context files), and compaction settings, but keeps
 * its own transcript and event stream. Events never reach the parent session.
 */

import type { AgentMessage, AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@gatanot/orrery-agent-core";
import { Agent } from "@gatanot/orrery-agent-core";
import { getCurrentSystemMessage, type RetryPolicy } from "@gatanot/orrery-ai";
import type { AssistantMessage, Message, Model } from "@gatanot/orrery-ai/compat";
import { type Static, Type } from "typebox";
import {
	type CompactionSettings,
	compact,
	estimateProjectedContextTokens,
	prepareCompaction,
	shouldCompact,
} from "../compaction/index.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import {
	buildSystemPrompt,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "../system-prompt.ts";

export const SUBAGENT_TOOL_NAME = "subagent";
export const END_TASK_TOOL_NAME = "end_task";

/** Hard cap so a runaway child cannot loop forever. Auto-compaction handles context size, not turn count. */
const MAX_SUBAGENT_TURNS = 50;
/** Minimum interval between streamed progress updates. */
const PROGRESS_THROTTLE_MS = 150;

const END_TASK_SNIPPET = "Finish the delegated task and report the result back to the main agent";

const END_TASK_GUIDELINES = ["Call end_task once the delegated task is complete or cannot continue"];

const SUBAGENT_PROMPT_SECTION = [
	"You are a subagent invoked by the main agent to complete one self-contained task.",
	"You cannot ask the user questions and must work autonomously with the available tools.",
	"When you are done, call end_task with a concise report: what you did, files changed, verification performed,",
	"and any blockers. If you cannot complete the task, call end_task with the partial result and explain what stopped you.",
].join(" ");

export const subagentToolSystemPromptContribution: { snippet: string; guidelines: readonly string[] } = {
	snippet: "Delegate a self-contained task to a subagent that runs in a fresh context and reports back",
	guidelines: [
		"Use subagent for self-contained tasks that can run autonomously; include all context the subagent needs in the prompt",
	],
};

const subagentSchema = Type.Object({
	prompt: Type.String({
		description:
			"Self-contained task for the subagent. Include all necessary context: the subagent cannot see this conversation and cannot ask follow-up questions.",
	}),
});

const endTaskSchema = Type.Object({
	report: Type.String({
		description:
			"Final report for the main agent: what you did, files changed, verification performed, and any blockers.",
	}),
});

export type SubagentToolInput = Static<typeof subagentSchema>;

/**
 * Runtime hooks the subagent tool needs from the owning AgentSession.
 *
 * Kept as an interface with closures so the tool module does not import AgentSession
 * (which imports this module) and does not depend on session internals.
 */
export interface SubagentRuntime {
	/** Working directory for the child session. */
	cwd: string;
	/** Parent agent; the child inherits its stream function, hooks, and loop options. */
	parentAgent: Agent;
	/** Structured parent system prompt options; the child overrides tools and sections. */
	getSystemPromptOptions(): NormalizedBuildSystemPromptOptions;
	getCompactionSettings(model: Model<any>): CompactionSettings;
	getRetrySettings(): RetryPolicy;
	getSummarizationAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}>;
}

export function createSubagentToolDefinition(
	runtime: SubagentRuntime,
): ToolDefinition<typeof subagentSchema, undefined> {
	return {
		name: SUBAGENT_TOOL_NAME,
		label: "subagent",
		description: [
			"Delegate a task to a subagent that runs with the same tools in a fresh context.",
			"The subagent works autonomously, cannot ask questions, and returns a final report.",
			"Use it for self-contained research or implementation tasks that would otherwise flood the main context.",
		].join(" "),
		promptSnippet: subagentToolSystemPromptContribution.snippet,
		promptGuidelines: [...subagentToolSystemPromptContribution.guidelines],
		parameters: subagentSchema,
		async execute(_toolCallId, { prompt }, signal, onUpdate) {
			return await runSubagent(runtime, prompt, signal, onUpdate);
		},
	};
}

export async function runSubagent(
	runtime: SubagentRuntime,
	prompt: string,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<undefined> | undefined,
): Promise<AgentToolResult<undefined>> {
	if (signal?.aborted) {
		throw new Error("Subagent aborted.");
	}

	const parentAgent = runtime.parentAgent;
	const model = parentAgent.state.model;
	const sessionManager = SessionManager.inMemory(runtime.cwd);

	let report: string | undefined;
	let turnCount = 0;
	let turnLimitExceeded = false;
	let lastProgressText: string | undefined;
	let lastProgressAt = 0;

	const publishProgress = (text: string | undefined, force = false): void => {
		if (!onUpdate || !text || text === lastProgressText) return;
		const now = Date.now();
		if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
		lastProgressText = text;
		lastProgressAt = now;
		onUpdate({ content: [{ type: "text", text }], details: undefined });
	};

	// Reuse the parent's wrapped tools so extension registrations and hooks stay consistent.
	// Extension tools still receive the parent's extension context; a child-side context is out of scope for v1.
	const childTools: AgentTool<any>[] = [
		...parentAgent.state.tools.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME && tool.name !== END_TASK_TOOL_NAME),
		createEndTaskTool((value) => {
			report = value;
		}),
	];

	const child = new Agent({
		initialState: {
			systemPrompt: buildChildSystemPrompt(
				runtime,
				childTools.map((tool) => tool.name),
			),
			model,
			thinkingLevel: parentAgent.state.thinkingLevel,
			tools: childTools,
			messages: [],
		},
		convertToLlm: parentAgent.convertToLlm,
		streamFn: parentAgent.streamFunction,
		getApiKey: parentAgent.getApiKey,
		onPayload: parentAgent.onPayload,
		onResponse: parentAgent.onResponse,
		beforeToolCall: parentAgent.beforeToolCall,
		afterToolCall: parentAgent.afterToolCall,
		thinkingBudgets: parentAgent.thinkingBudgets,
		transport: parentAgent.transport,
		maxRetryDelayMs: parentAgent.maxRetryDelayMs,
		toolExecution: parentAgent.toolExecution,
		prepareRequest: async (request, requestSignal) => {
			await compactChildIfNeeded(runtime, sessionManager, request.model, requestSignal);
			return {
				context: {
					...request.context,
					messages: sessionManager.buildSessionProjection().messages,
				},
			};
		},
		finishTurn: () => {
			if (report !== undefined) return { action: "end" };
			turnCount += 1;
			if (turnCount >= MAX_SUBAGENT_TURNS) {
				turnLimitExceeded = true;
				return { action: "end" };
			}
			return undefined;
		},
	});

	// The initial system message is part of the child transcript but is not emitted as an
	// event, so persist it explicitly to keep the session projection complete.
	const initialSystemMessage = getCurrentSystemMessage(child.state.messages);
	if (initialSystemMessage) {
		sessionManager.appendMessage(initialSystemMessage);
	}

	const unsubscribe = child.subscribe((event) => {
		if (event.type === "message_end") {
			if (isChildMessage(event.message)) {
				sessionManager.appendMessage(event.message);
			}
			if (event.message.role === "assistant") {
				publishProgress(pickLastAssistantText([event.message]), true);
			}
			return;
		}
		if (event.type === "message_update" && event.message.role === "assistant") {
			publishProgress(pickLastAssistantText([event.message]));
		}
	});

	const onAbort = () => child.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await child.prompt(prompt);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	}

	if (signal?.aborted) {
		throw new Error("Subagent aborted.");
	}
	if (turnLimitExceeded) {
		throw new Error(`Subagent exceeded the ${MAX_SUBAGENT_TURNS} turn limit without finishing.`);
	}

	const lastAssistant = findLastAssistant(child.state.messages);
	if (lastAssistant?.stopReason === "aborted") {
		throw new Error("Subagent aborted.");
	}
	if (lastAssistant?.stopReason === "error") {
		throw new Error(lastAssistant.errorMessage || "Subagent failed.");
	}

	if (report !== undefined) {
		return { content: [{ type: "text", text: report }], details: undefined };
	}

	const text = pickLastAssistantText(child.state.messages);
	return { content: [{ type: "text", text: text ?? "(no output)" }], details: undefined };
}

function createEndTaskTool(onReport: (report: string) => void): AgentTool<typeof endTaskSchema> {
	return {
		name: END_TASK_TOOL_NAME,
		label: "end_task",
		description:
			"Finish the delegated task and return the final report to the main agent. The main agent only sees this report.",
		parameters: endTaskSchema,
		async execute(_toolCallId, { report }) {
			onReport(report);
			return {
				content: [{ type: "text", text: report }],
				details: undefined,
				terminate: true,
			};
		},
	};
}

function buildChildSystemPrompt(runtime: SubagentRuntime, childToolNames: string[]): string {
	const parentOptions = runtime.getSystemPromptOptions();
	return buildSystemPrompt(
		normalizeBuildSystemPromptOptions({
			...parentOptions,
			forceSystemPrompt: undefined,
			customPrompt: parentOptions.forceSystemPrompt ?? parentOptions.customPrompt,
			selectedTools: childToolNames,
			toolSnippets: { ...parentOptions.toolSnippets, [END_TASK_TOOL_NAME]: END_TASK_SNIPPET },
			toolGuidelines: { ...parentOptions.toolGuidelines, [END_TASK_TOOL_NAME]: [...END_TASK_GUIDELINES] },
			sections: { ...parentOptions.sections, subagent: SUBAGENT_PROMPT_SECTION },
		}),
	);
}

async function compactChildIfNeeded(
	runtime: SubagentRuntime,
	sessionManager: SessionManager,
	requestModel: Model<any>,
	signal: AbortSignal | undefined,
): Promise<void> {
	const settings = runtime.getCompactionSettings(requestModel);
	if (!settings.enabled || requestModel.contextWindow <= 0) return;

	const projection = sessionManager.buildSessionProjection();
	const tokens = estimateProjectedContextTokens(projection, sessionManager.getBranch()).tokens;
	if (!shouldCompact(tokens, requestModel.contextWindow, settings)) return;

	const preparation = prepareCompaction(sessionManager.getBranch(), settings);
	if (!preparation) return;

	const { model, apiKey, headers, env } = await runtime.getSummarizationAuth(requestModel, signal);
	const result = await compact(
		preparation,
		model,
		apiKey,
		headers,
		undefined,
		signal,
		runtime.parentAgent.state.thinkingLevel,
		runtime.parentAgent.streamFunction,
		env,
		runtime.getRetrySettings(),
		undefined,
		undefined,
	);
	sessionManager.appendCompaction(
		result.summary,
		result.firstKeptEntryId,
		result.tokensBefore,
		result.details,
		false,
		result.usage,
	);
}

function isChildMessage(message: AgentMessage): message is Message {
	return (
		message.role === "system" ||
		message.role === "user" ||
		message.role === "assistant" ||
		message.role === "toolResult"
	);
}

function findLastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

/** Last assistant text, scanning backwards, mirroring the example subagent extension's behavior. */
function pickLastAssistantText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
		const trimmed = text.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

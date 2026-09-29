import { parseDiffLines } from "./diff.ts";
import { renderMarkdown } from "./markdown.ts";
import type { WebSnapshot, WebToolExecution } from "./protocol.ts";
import type { AppState, Block, DiffLine, Message, Tool, ToolImage } from "./types.ts";

interface WireRecord {
	[key: string]: unknown;
}

function record(value: unknown): WireRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as WireRecord) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	const item = record(value);
	if (!item) return "";
	if (item.type === "text") return stringValue(item.text) ?? "";
	if (item.type === "thinking") return stringValue(item.thinking) ?? "";
	if (item.type === "image") return "[image]";
	return "";
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	return arrayValue(value).map(textContent).filter(Boolean).join("\n");
}

function compactJson(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "[unable to display structured data]";
	}
}

function timestamp(value: unknown): string {
	if (typeof value !== "number") return "now";
	return new Date(value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function toolTarget(args: unknown): string {
	const values = record(args);
	if (!values) return compactJson(args);
	for (const key of ["path", "file", "url", "query", "command", "pattern"]) {
		const value = values[key];
		if (typeof value === "string" && value) return value;
	}
	return compactJson(args);
}

function resultText(value: unknown): string {
	const result = record(value);
	if (!result) return compactJson(value);
	const content = contentText(result.content);
	if (content) return content;
	if (result.details !== undefined) return compactJson(result.details);
	return compactJson(value);
}

/** Extracts base64 image parts from a tool result or content array; pi already embeds them. */
function imagesFrom(value: unknown): ToolImage[] {
	const content = arrayValue(record(value)?.content ?? value);
	const images: ToolImage[] = [];
	for (const item of content) {
		const part = record(item);
		if (part?.type !== "image") continue;
		const data = stringValue(part.data);
		const mimeType = stringValue(part.mimeType);
		if (data && mimeType) images.push({ mimeType, data });
	}
	return images;
}

function thinkingLabel(level: string | undefined): string {
	switch (level) {
		case "off":
			return "Off";
		case "minimal":
		case "low":
			return "Low";
		case "high":
		case "xhigh":
		case "max":
			return "High";
		case "medium":
			return "Medium";
		default:
			return level ?? "Medium";
	}
}

function messageBlocks(message: WireRecord): Block[] {
	const blocks: Block[] = [];
	for (const item of arrayValue(message.content)) {
		const part = record(item);
		if (!part) continue;
		if (part.type === "text") {
			const text = stringValue(part.text) ?? "";
			if (text)
				blocks.push(
					text.length > 5_000 ? { type: "largeOutput", text } : { type: "text", text, html: renderMarkdown(text) },
				);
		} else if (part.type === "thinking") {
			const text = stringValue(part.thinking) ?? "";
			if (text) blocks.push({ type: "thinking", text, html: renderMarkdown(text) });
		} else if (part.type === "image") {
			const data = stringValue(part.data);
			const mimeType = stringValue(part.mimeType);
			if (data && mimeType) blocks.push({ type: "image", mimeType, data });
			else blocks.push({ type: "text", text: "[image]", html: renderMarkdown("[image]") });
		}
	}
	return blocks;
}

function toolCalls(message: WireRecord): WireRecord[] {
	return arrayValue(message.content)
		.map(record)
		.filter((part): part is WireRecord => part?.type === "toolCall");
}

function toolResultMap(messages: WireRecord[]): Map<string, WireRecord> {
	const results = new Map<string, WireRecord>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const id = stringValue(message.toolCallId);
		if (id) results.set(id, message);
	}
	return results;
}

function diffOutput(value: unknown): DiffLine[] | undefined {
	const details = record(record(value)?.details);
	const diff = stringValue(details?.diff);
	return diff ? parseDiffLines(diff) : undefined;
}

function toolFromCall(call: WireRecord, result: WireRecord | undefined, execution: WebToolExecution | undefined): Tool {
	const name = stringValue(call.name) ?? execution?.toolName ?? "tool";
	const id = stringValue(call.id) ?? execution?.toolCallId ?? `tool-${name}`;
	const isError = execution?.status === "error" || result?.isError === true || execution?.isError === true;
	const running = execution?.status === "running";
	const outputValue = execution?.partialResult ?? execution?.result ?? result;
	const rawArgs = call.arguments ?? execution?.args;
	const timeout = record(rawArgs)?.timeout;
	const diff = diffOutput(outputValue);
	const images = imagesFrom(outputValue);
	return {
		id,
		name,
		target: toolTarget(rawArgs),
		status: running ? "running" : isError ? "error" : "done",
		statusText: running ? "Running" : isError ? "Fail" : "Done",
		input: compactJson(rawArgs),
		...(diff ? { output: diff, outputType: "diff" as const } : { output: resultText(outputValue) }),
		...(images.length > 0 ? { images } : {}),
		...(execution?.startedAt === undefined ? {} : { startedAt: execution.startedAt }),
		...(execution?.finishedAt === undefined ? {} : { finishedAt: execution.finishedAt }),
		...(typeof timeout === "number" ? { timeoutSeconds: timeout } : {}),
	};
}

function toolMessage(
	calls: WireRecord[],
	results: Map<string, WireRecord>,
	executions: Map<string, WebToolExecution>,
	index: number,
): Message {
	return {
		id: `tools-${index}-${calls.map((call) => stringValue(call.id) ?? "unknown").join("-")}`,
		role: "tools",
		label: "Tool execution",
		avatar: "↳",
		time: timestamp(calls[0]?.timestamp),
		tools: calls.map((call) => {
			const id = stringValue(call.id) ?? "";
			return toolFromCall(call, results.get(id), executions.get(id));
		}),
	};
}

function assistantMessage(
	message: WireRecord,
	index: number,
	executions: Map<string, WebToolExecution>,
	results: Map<string, WireRecord>,
): Message[] {
	const blocks = messageBlocks(message);
	const errorMessage = stringValue(message.errorMessage);
	const output: Message[] = [];
	if (blocks.length > 0 || errorMessage) {
		output.push({
			id: `assistant-${index}-${String(message.timestamp ?? "")}`,
			role: "assistant",
			label: "Orrery",
			avatar: "O",
			time: timestamp(message.timestamp),
			blocks,
			error: errorMessage,
		});
	}
	const calls = toolCalls(message);
	if (calls.length > 0) output.push(toolMessage(calls, results, executions, index));
	return output;
}

function mapExecutions(snapshot: WebSnapshot): Map<string, WebToolExecution> {
	return new Map(snapshot.toolExecutions.map((execution) => [execution.toolCallId, execution]));
}

function mapCommittedMessages(
	messages: WireRecord[],
	results: Map<string, WireRecord>,
	executions: Map<string, WebToolExecution>,
): Message[] {
	const output: Message[] = [];
	const knownToolCalls = new Set<string>();

	messages.forEach((message, index) => {
		if (message.role === "user") {
			const blocks = messageBlocks(message);
			if (blocks.length === 0) {
				const text = contentText(message.content);
				blocks.push({ type: "text", text, html: renderMarkdown(text) });
			}
			output.push({
				id: `user-${index}-${String(message.timestamp ?? "")}`,
				role: "user",
				label: "You",
				avatar: "You",
				time: timestamp(message.timestamp),
				blocks,
			});
		} else if (message.role === "assistant") {
			for (const call of toolCalls(message)) {
				const id = stringValue(call.id);
				if (id) knownToolCalls.add(id);
			}
			output.push(...assistantMessage(message, index, executions, results));
		} else if (message.role === "toolResult" && !knownToolCalls.has(stringValue(message.toolCallId) ?? "")) {
			const images = imagesFrom(message);
			output.push({
				id: `tool-result-${index}`,
				role: "tools",
				label: stringValue(message.toolName) ?? "Tool result",
				avatar: "↳",
				time: timestamp(message.timestamp),
				tools: [
					{
						id: stringValue(message.toolCallId) ?? `tool-result-${index}`,
						name: stringValue(message.toolName) ?? "tool",
						target: "",
						status: message.isError === true ? "error" : "done",
						statusText: message.isError === true ? "Fail" : "Done",
						input: "",
						output: resultText(message),
						...(images.length > 0 ? { images } : {}),
					},
				],
			});
		}
	});
	return output;
}

// Rendering the whole transcript on every streamed token is expensive. The committed transcript
// only changes when the messages array or tool executions change, so reuse its mapped result.
let committedCache: { source: unknown[]; executions: string; mapped: Message[] } | undefined;

function mapMessages(snapshot: WebSnapshot): Message[] {
	const messages = snapshot.messages.map(record).filter((message): message is WireRecord => message !== undefined);
	const results = toolResultMap(messages);
	const executions = mapExecutions(snapshot);
	const executionSignature = JSON.stringify(snapshot.toolExecutions);
	let committed: Message[];
	if (
		committedCache &&
		committedCache.source === snapshot.messages &&
		committedCache.executions === executionSignature
	) {
		committed = committedCache.mapped;
	} else {
		committed = mapCommittedMessages(messages, results, executions);
		committedCache = { source: snapshot.messages, executions: executionSignature, mapped: committed };
	}
	const output = committed.slice();

	const streaming = record(snapshot.streamingMessage);
	if (streaming && streaming.role === "assistant") {
		const streamingMessages = assistantMessage(streaming, messages.length, executions, results);
		for (const message of streamingMessages) {
			if (message.role === "assistant") message.label = "Orrery · streaming";
			output.push(message);
		}
	}
	// A turn-level error must stay visible at the end of the conversation even when the failed
	// assistant message carried no content blocks of its own. Attach the retry action to the latest
	// message carrying the error, cloning it so the committed cache stays untouched.
	if (snapshot.error) {
		let index = -1;
		for (let i = output.length - 1; i >= 0; i--) {
			if (output[i]?.error === snapshot.error) {
				index = i;
				break;
			}
		}
		if (index >= 0) {
			output[index] = { ...output[index], errorAction: "retry" };
		} else {
			output.push({
				id: "turn-error",
				role: "assistant",
				label: "Orrery",
				avatar: "!",
				time: "now",
				blocks: [],
				error: snapshot.error,
				errorAction: "retry",
			});
		}
	}
	return output;
}

function usageText(snapshot: WebSnapshot): string {
	const tokens = snapshot.contextUsage?.tokens;
	if (typeof tokens === "number") return `${tokens.toLocaleString("en-US")} tokens`;
	return "Unknown";
}

function modelText(snapshot: WebSnapshot): string {
	if (!snapshot.model) return "No model configured";
	return `${snapshot.model.provider} / ${snapshot.model.id}`;
}

function sessionTitle(snapshot: WebSnapshot): string {
	if (snapshot.sessionName) return snapshot.sessionName;
	const firstUser = snapshot.messages.map(record).find((message) => message?.role === "user");
	const text = firstUser ? contentText(firstUser.content).trim() : "";
	return text.slice(0, 52) || (snapshot.messages.length > 0 ? "Current session" : "New session");
}

/** Text of the most recent user message, used to re-run a failed turn. */
export function lastUserPromptText(snapshot: WebSnapshot): string {
	for (let index = snapshot.messages.length - 1; index >= 0; index--) {
		const message = record(snapshot.messages[index]);
		if (message?.role !== "user") continue;
		const text = contentText(message.content).trim();
		if (text) return text;
	}
	return "";
}

export function snapshotToAppState(
	snapshot: WebSnapshot,
	connection: "connected" | "connecting" | "disconnected",
): AppState {
	if (!snapshot.ready) {
		const error = snapshot.error ?? "Agent session is not available yet";
		const noModel = error.toLowerCase().includes("model");
		return {
			title: noModel ? "No model available yet" : "Could not initialize the agent",
			subtitle: snapshot.cwd,
			sessionId: "",
			phase: "unavailable",
			phaseLabel: connection === "disconnected" ? "Disconnected" : "Unavailable",
			phaseTone: connection === "disconnected" ? "disconnected" : "error",
			connection,
			model: "No model configured",
			modelKey: "",
			models: [],
			thinking: "Medium",
			thinkingLevel: snapshot.thinkingLevel ?? "off",
			thinkingLevels: [],
			usage: "Waiting for configuration",
			messages: [],
			draft: "",
			noModel,
			unavailable: !noModel,
			notice: {
				kind: noModel ? "warning" : "error",
				title: noModel ? "Configure a model first" : "Agent session unavailable",
				body: error,
				action: noModel ? "configure" : "retry",
				actionLabel: noModel ? "Open settings" : "Retry connection",
			},
		};
	}

	const hasUsableModel =
		snapshot.model !== undefined &&
		snapshot.models.some((model) => model.provider === snapshot.model?.provider && model.id === snapshot.model?.id);
	const running = snapshot.phase === "streaming" || snapshot.phase === "stopping";
	const compacting = snapshot.phase === "compacting";
	const hasError = snapshot.phase === "error" || Boolean(snapshot.error);
	const messages = mapMessages(snapshot);
	const errorShownInline = messages.some((message) => message.error === snapshot.error);
	return {
		title: sessionTitle(snapshot),
		subtitle: snapshot.cwd,
		sessionId: snapshot.sessionId ?? "",
		phase: compacting ? "compacting" : running ? "running" : snapshot.phase === "error" ? "error" : "idle",
		phaseLabel:
			snapshot.phase === "compacting"
				? "Compacting"
				: snapshot.phase === "streaming"
					? "Working"
					: snapshot.phase === "stopping"
						? "Stopping"
						: hasError
							? "Error"
							: "Idle",
		phaseTone: compacting ? "compacting" : running ? "running" : hasError ? "error" : "idle",
		connection,
		model: modelText(snapshot),
		modelKey: snapshot.model ? JSON.stringify([snapshot.model.provider, snapshot.model.id]) : "",
		models: snapshot.models,
		thinking: thinkingLabel(snapshot.thinkingLevel),
		thinkingLevel: snapshot.thinkingLevel ?? "off",
		thinkingLevels: snapshot.thinkingLevels,
		usage: usageText(snapshot),
		messages,
		draft: "",
		noModel: !hasUsableModel,
		...(snapshot.queuedMessages ? { queuedMessages: snapshot.queuedMessages } : {}),
		...(snapshot.error && !errorShownInline
			? {
					notice: {
						kind: "error" as const,
						title: "This turn failed",
						body: snapshot.error,
						action: "retry" as const,
						actionLabel: "Retry",
					},
				}
			: !hasUsableModel
				? {
						notice: {
							kind: "warning" as const,
							title: "Configure an available model",
							body: "The current session has no authenticated model selected.",
						},
					}
				: {}),
	};
}

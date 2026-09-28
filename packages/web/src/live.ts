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
	if (item.type === "image") return "[图片]";
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
		return "[无法显示结构化数据]";
	}
}

function timestamp(value: unknown): string {
	if (typeof value !== "number") return "现在";
	return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
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
			return "关闭";
		case "minimal":
		case "low":
			return "低";
		case "high":
		case "xhigh":
		case "max":
			return "高";
		case "medium":
			return "中";
		default:
			return level ?? "中";
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
			else blocks.push({ type: "text", text: "[图片]", html: renderMarkdown("[图片]") });
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
		label: "工具执行",
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
				label: "你",
				avatar: "你",
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
				label: stringValue(message.toolName) ?? "工具结果",
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
			if (message.role === "assistant") message.label = "Orrery · 生成中";
			output.push(message);
		}
	}
	// A turn-level error must stay visible at the end of the conversation even when the failed
	// assistant message carried no content blocks of its own.
	if (snapshot.error && !output.some((message) => message.error === snapshot.error)) {
		output.push({
			id: "turn-error",
			role: "assistant",
			label: "Orrery",
			avatar: "!",
			time: "现在",
			blocks: [],
			error: snapshot.error,
		});
	}
	return output;
}

function usageText(snapshot: WebSnapshot): string {
	const tokens = snapshot.contextUsage?.tokens;
	if (typeof tokens === "number") return `${tokens.toLocaleString("en-US")} tokens`;
	return "未知";
}

function modelText(snapshot: WebSnapshot): string {
	if (!snapshot.model) return "未配置模型";
	return `${snapshot.model.provider} / ${snapshot.model.id}`;
}

function sessionTitle(snapshot: WebSnapshot): string {
	if (snapshot.sessionName) return snapshot.sessionName;
	const firstUser = snapshot.messages.map(record).find((message) => message?.role === "user");
	const text = firstUser ? contentText(firstUser.content).trim() : "";
	return text.slice(0, 52) || (snapshot.messages.length > 0 ? "当前 session" : "新 session");
}

export function snapshotToAppState(
	snapshot: WebSnapshot,
	connection: "connected" | "connecting" | "disconnected",
): AppState {
	if (!snapshot.ready) {
		const error = snapshot.error ?? "Agent session 尚未可用";
		const noModel = error.toLowerCase().includes("model");
		return {
			title: noModel ? "还没有可用模型" : "无法初始化 agent",
			subtitle: snapshot.cwd,
			sessionId: "",
			phase: "unavailable",
			phaseLabel: connection === "disconnected" ? "连接断开" : "不可用",
			phaseTone: connection === "disconnected" ? "disconnected" : "error",
			connection,
			model: "未配置模型",
			modelKey: "",
			models: [],
			thinking: "中",
			thinkingLevel: snapshot.thinkingLevel ?? "off",
			thinkingLevels: [],
			usage: "等待配置",
			messages: [],
			draft: "",
			noModel,
			unavailable: !noModel,
			notice: {
				kind: noModel ? "warning" : "error",
				title: noModel ? "需要先配置模型" : "Agent session 不可用",
				body: error,
				action: noModel ? "configure" : "retry",
				actionLabel: noModel ? "打开配置" : "重试连接",
			},
		};
	}

	const hasUsableModel =
		snapshot.model !== undefined &&
		snapshot.models.some((model) => model.provider === snapshot.model?.provider && model.id === snapshot.model?.id);
	const running = snapshot.phase === "streaming" || snapshot.phase === "stopping";
	const hasError = snapshot.phase === "error" || Boolean(snapshot.error);
	const messages = mapMessages(snapshot);
	const errorShownInline = messages.some((message) => message.error === snapshot.error);
	return {
		title: sessionTitle(snapshot),
		subtitle: snapshot.cwd,
		sessionId: snapshot.sessionId ?? "",
		phase: running ? "running" : snapshot.phase === "error" ? "error" : "idle",
		phaseLabel:
			snapshot.phase === "streaming"
				? "Working"
				: snapshot.phase === "stopping"
					? "停止中"
					: hasError
						? "Error"
						: "空闲",
		phaseTone: running ? "running" : hasError ? "error" : "idle",
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
						title: "这一轮执行失败",
						body: snapshot.error,
						action: "retry" as const,
						actionLabel: "重试任务",
					},
				}
			: !hasUsableModel
				? {
						notice: {
							kind: "warning" as const,
							title: "需要配置可用模型",
							body: "当前 session 尚未选择已认证的可用模型。",
						},
					}
				: {}),
	};
}

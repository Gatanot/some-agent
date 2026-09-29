export type LayoutName = "sidebar" | "drawer";
export type ToolStatus = "done" | "running" | "error";
export type NoticeKind = "empty" | "history" | "error" | "warning";
export type PhaseTone = "idle" | "running" | "compacting" | "error" | "disconnected";

export interface DiffLine {
	kind: "add" | "remove" | "context";
	text: string;
}

/** Base64 image content as delivered by the agent (for example a `read` tool result). */
export interface ToolImage {
	mimeType: string;
	data: string;
}

export interface Tool {
	id: string;
	name: string;
	target: string;
	status: ToolStatus;
	statusText: string;
	input: string;
	output: string | DiffLine[];
	outputType?: "diff";
	images?: ToolImage[];
	startedAt?: number;
	finishedAt?: number;
	timeoutSeconds?: number;
}

export type Block =
	| { type: "text" | "thinking"; text: string; html: string }
	| { type: "largeOutput"; text: string }
	| { type: "code"; language: string; text: string }
	| { type: "image"; mimeType: string; data: string };

export interface Message {
	id: string;
	role: "user" | "assistant" | "tools";
	label: string;
	avatar: string;
	time: string;
	blocks?: Block[];
	tools?: Tool[];
	error?: string;
	errorAction?: "retry";
}

export interface Notice {
	kind: NoticeKind;
	title: string;
	body: string;
	action?: "retry" | "configure" | "new" | "restore";
	actionLabel?: string;
}

export interface ModelOption {
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
}

export interface QueuedMessages {
	steering: string[];
	followUp: string[];
}

export interface AppState {
	title: string;
	subtitle: string;
	sessionId: string;
	phase: string;
	phaseLabel: string;
	phaseTone: PhaseTone;
	connection: "connected" | "disconnected" | "connecting";
	model: string;
	modelKey: string;
	models: ModelOption[];
	thinking: string;
	thinkingLevel: string;
	thinkingLevels: string[];
	usage: string;
	messages: Message[];
	draft: string;
	noModel?: boolean;
	unavailable?: boolean;
	notice?: Notice;
	queuedMessages?: QueuedMessages;
}

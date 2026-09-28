export type WebSessionPhase = "unavailable" | "idle" | "streaming" | "stopping" | "error";

export interface WebToolExecution {
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "running" | "done" | "error";
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	startedAt?: number;
	finishedAt?: number;
}

export interface WebSessionSummary {
	id: string;
	name?: string;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface WebSessionsResponse {
	sessions: WebSessionSummary[];
	currentSessionId?: string;
}

/** A session whose title or transcript matched a `/api/sessions/search` query. */
export interface WebSessionMatch extends WebSessionSummary {
	snippet: string;
	matchCount: number;
}

export interface WebSessionSearchResponse {
	query: string;
	matches: WebSessionMatch[];
}

export interface WebModelOption {
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
}

export interface WebGitFile {
	code: string;
	path: string;
	previousPath?: string;
	added?: number;
	removed?: number;
}

export interface WebGitDiff {
	path: string;
	diff: string;
	truncated: boolean;
}

export interface WebGitState {
	state: "loading" | "ready" | "unavailable" | "error";
	files: WebGitFile[];
	root?: string;
	branch?: string;
	updatedAt?: string;
	error?: string;
}

export interface WebContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface WebUsageModel {
	key: string;
	tokens: number;
	cost: number;
}

export interface WebUsageDay {
	date: string;
	tokens: number;
	cost: number;
}

export interface WebUsage {
	days: number;
	totalTokens: number;
	totalCost: number;
	models: WebUsageModel[];
	daily: WebUsageDay[];
}

export interface QueuedMessages {
	steering: string[];
	followUp: string[];
}

/**
 * Fields that change while a turn streams. Sent on every stream update so the client can
 * refresh the live view without re-sending the whole transcript on each token.
 */
export interface WebSnapshotDelta {
	protocolVersion: 1;
	sequence: number;
	ready: boolean;
	cwd: string;
	prompting: boolean;
	phase: WebSessionPhase;
	pendingToolCalls: string[];
	toolExecutions: WebToolExecution[];
	streamingMessage?: unknown;
	contextUsage?: WebContextUsage;
	thinkingLevel?: string;
	sessionId?: string;
	sessionName?: string;
	error?: string;
	queuedMessages?: QueuedMessages;
}

/** Full state. Sent when a client connects and whenever the transcript or heavy metadata changes. */
export interface WebSnapshot extends WebSnapshotDelta {
	messages: unknown[];
	git: WebGitState;
	model?: {
		provider: string;
		id: string;
	};
	models: WebModelOption[];
	thinkingLevels: string[];
}

export type WebEventEnvelope =
	| { kind: "snapshot"; snapshot: WebSnapshot; eventType?: string }
	| { kind: "update"; patch: WebSnapshotDelta; eventType?: string };

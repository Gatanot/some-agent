import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSession, AgentSessionEvent, SessionEntry, SessionInfo, SettingsManager } from "@gatanot/orrery";
import { createAgentSession, SessionManager } from "@gatanot/orrery";
import type { ViteDevServer } from "vite";
import { contextBreakdown } from "./context.ts";
import { parseFileLimit, searchProjectFiles } from "./files.ts";
import { readGitDiff, readGitStatus } from "./git.ts";
import type {
	WebEventEnvelope,
	WebGitState,
	WebSessionMatch,
	WebSessionSearchResponse,
	WebSessionStats,
	WebSessionSummary,
	WebSessionsResponse,
	WebSettings,
	WebSettingsModelThinkingLevel,
	WebSnapshot,
	WebSnapshotDelta,
	WebToolExecution,
	WebUsage,
	WebUsageDay,
	WebUsageModel,
} from "./protocol.ts";
import { localDateKey, summarizeUsage, type UsageSummary } from "./usage.ts";

const require = createRequire(import.meta.url);
type ViteCreateServer = (options: {
	root: string;
	server: { middlewareMode: true };
	appType: "spa";
}) => Promise<ViteDevServer>;

const configuredPort = parsePort(process.env.PI_WEB_PORT ?? "3210");
const configuredCwd = process.env.PI_WEB_CWD ?? process.cwd();
const webRoot = resolve(import.meta.dirname, "..");
const distRoot = process.env.PI_WEB_ASSETS ? resolve(process.env.PI_WEB_ASSETS) : join(webRoot, "dist");
const pagePath = join(distRoot, "index.html");

let port = configuredPort;
let initialDirectory = configuredCwd;
let isDevelopment = process.env.PI_WEB_MODE !== "production";
const MAX_REQUEST_BYTES = 64 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_QUEUED_SSE_FRAMES = 16;
const DEFAULT_USAGE_DAYS = 14;
const MAX_USAGE_DAYS = 90;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const SNIPPET_CONTEXT = 60;
const MAX_WORKSPACES = 8;
const MAX_BROWSE_ENTRIES = 300;

interface WorkspaceRuntime {
	id: string;
	cwd: string;
	session?: AgentSession;
	sessionError?: string;
	promptError?: string;
	activePrompt?: { session: AgentSession };
	aborting: boolean;
	compacting: boolean;
	sessionOperation?: Promise<void>;
	sequence: number;
	gitRefreshId: number;
	gitState: WebGitState;
	activeToolExecutions: Map<string, WebToolExecution>;
	sessionCatalog: Map<string, SessionInfo>;
	usageCache: Map<string, { modified: number; since: number; summary: UsageSummary }>;
	deletedSessionUsage: Map<string, SessionEntry[]>;
	recentWorkspaces: string[];
	lastUsed: number;
	subscribers: Set<SseSubscriber>;
}

function createWorkspaceRuntime(id: string, directory: string): WorkspaceRuntime {
	return {
		id,
		cwd: directory,
		aborting: false,
		compacting: false,
		sequence: 0,
		gitRefreshId: 0,
		gitState: { state: "loading", files: [] },
		activeToolExecutions: new Map(),
		sessionCatalog: new Map(),
		usageCache: new Map(),
		deletedSessionUsage: new Map(),
		recentWorkspaces: [directory],
		lastUsed: Date.now(),
		subscribers: new Set(),
	};
}

const runtimeStorage = new AsyncLocalStorage<WorkspaceRuntime>();
const workspaceRuntimes = new Map<string, WorkspaceRuntime>();
let defaultRuntime: WorkspaceRuntime | undefined;

/**
 * Resolves the workspace runtime for the current request, or the server's default runtime when
 * called outside a request context (startup, shutdown, and background session callbacks).
 */
function runtime(): WorkspaceRuntime {
	const value = runtimeStorage.getStore() ?? defaultRuntime;
	if (!value) throw new Error("Workspace runtime is unavailable");
	return value;
}

interface SseSubscriber {
	response: ServerResponse;
	heartbeat: ReturnType<typeof setInterval>;
	queue: string[];
	blocked: boolean;
	closed: boolean;
}

class HttpRequestError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpRequestError";
		this.status = status;
	}
}

export type SessionSelection = "recent" | "new" | { path: string };

type SessionFactory = (selection: SessionSelection, cwd: string) => Promise<AgentSession>;
type SessionLister = (cwd: string) => Promise<SessionInfo[]>;

export interface WebServerOptions {
	cwd?: string;
	port?: number;
	mode?: "development" | "production";
	sessionFactory?: SessionFactory;
	sessionLister?: SessionLister;
}

export interface WebServerHandle {
	server: Server;
	readonly port: number;
	close: () => Promise<void>;
}

let sessionFactory: SessionFactory | undefined;
let sessionLister: SessionLister | undefined;
let defaultWorkspaceId = "";
let vite: ViteDevServer | undefined;

function getWorkspace(id: string | undefined): WorkspaceRuntime {
	if (!id) {
		const fallback = workspaceRuntimes.get(defaultWorkspaceId);
		if (!fallback) throw new HttpRequestError(503, "Workspace is not available");
		return fallback;
	}
	const existing = workspaceRuntimes.get(id);
	if (!existing) throw new HttpRequestError(400, "Workspace is not available");
	existing.lastUsed = Date.now();
	return existing;
}

/** Creates an isolated workspace for a new client, evicting the least recently used idle one when full. */
function createAdditionalWorkspace(): WorkspaceRuntime {
	if (workspaceRuntimes.size >= MAX_WORKSPACES && !evictIdleWorkspace()) {
		throw new HttpRequestError(503, "Too many active workspaces");
	}
	const created = createWorkspaceRuntime(randomUUID(), initialDirectory);
	workspaceRuntimes.set(created.id, created);
	return created;
}

function evictIdleWorkspace(): boolean {
	let oldest: WorkspaceRuntime | undefined;
	for (const value of workspaceRuntimes.values()) {
		if (value.id === defaultWorkspaceId) continue;
		if (value.subscribers.size > 0 || value.activePrompt || value.sessionOperation || value.aborting) continue;
		if (value.session?.isStreaming || value.compacting) continue;
		if (!oldest || value.lastUsed < oldest.lastUsed) oldest = value;
	}
	if (!oldest) return false;
	workspaceRuntimes.delete(oldest.id);
	const session = oldest.session;
	oldest.session = undefined;
	if (session) void session.dispose();
	return true;
}

function parsePort(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
		throw new Error(`PI_WEB_PORT must be an integer between 1 and 65535, received ${value}`);
	}
	return parsed;
}

async function validateWorkingDirectory(path = runtime().cwd): Promise<void> {
	try {
		const info = await stat(path);
		if (!info.isDirectory()) throw new Error("path is not a directory");
	} catch (error) {
		throw new Error(`Not a readable directory: ${path} (${error instanceof Error ? error.message : String(error)})`);
	}
}

interface BrowseEntry {
	name: string;
	path: string;
}

/** Subdirectories of `target`, non-hidden first, for the workspace picker browser. */
async function browseDirectories(target: string): Promise<BrowseEntry[]> {
	const entries = await readdir(target, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => entry.name)
		.sort((a, b) => Number(a.startsWith(".")) - Number(b.startsWith(".")) || a.localeCompare(b))
		.slice(0, MAX_BROWSE_ENTRIES)
		.map((name) => ({ name, path: join(target, name) }));
}

function wireStringify(value: unknown): string {
	// Track only the current ancestor path so shared (non-circular) references serialize
	// normally instead of being mistaken for cycles.
	const ancestors: object[] = [];
	return (
		JSON.stringify(value, function (_key: string, nested: unknown) {
			if (typeof nested === "bigint") return nested.toString();
			if (typeof nested === "function") return undefined;
			if (typeof nested === "object" && nested !== null) {
				while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
				if (ancestors.includes(nested)) return "[Circular]";
				ancestors.push(nested);
			}
			return nested;
		}) ?? "null"
	);
}

function sessionSummary(info: SessionInfo): WebSessionSummary {
	return {
		id: info.id,
		...(info.name ? { name: info.name } : {}),
		cwd: info.cwd,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage.slice(0, 240),
	};
}

async function listSessions(): Promise<WebSessionsResponse> {
	const sessions = await (sessionLister?.(runtime().cwd) ?? SessionManager.list(runtime().cwd));
	const current = runtime().session;
	runtime().sessionCatalog.clear();
	for (const info of sessions) runtime().sessionCatalog.set(info.id, info);
	return {
		sessions: sessions.map(sessionSummary),
		...(current?.sessionId ? { currentSessionId: current.sessionId } : {}),
	};
}

function parseSearchLimit(value: string | null): number {
	if (!value) return DEFAULT_SEARCH_LIMIT;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SEARCH_LIMIT) return DEFAULT_SEARCH_LIMIT;
	return parsed;
}

/** One-line excerpt around the first match so the sidebar can show where it hit. */
function sessionSnippet(source: string, needle: string, matchIndex: number): string {
	const start = Math.max(0, matchIndex - SNIPPET_CONTEXT);
	const end = Math.min(source.length, matchIndex + needle.length + SNIPPET_CONTEXT);
	const excerpt = source.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${excerpt}${end < source.length ? "…" : ""}`;
}

/**
 * Searches the session catalog built by the latest list, matching titles and full
 * user/assistant transcripts (`SessionInfo.allMessagesText`). Falls back to listing when the
 * catalog is empty so the endpoint works before the client has loaded history.
 */
async function searchSessions(rawQuery: string, limit: number): Promise<WebSessionSearchResponse> {
	const query = rawQuery.trim();
	if (!query) return { query, matches: [] };
	if (runtime().sessionCatalog.size === 0) await listSessions();

	const needle = query.toLowerCase();
	const matches: WebSessionMatch[] = [];
	for (const info of runtime().sessionCatalog.values()) {
		const transcript = info.allMessagesText;
		const haystack = `${info.name ?? ""}\n${transcript}`.toLowerCase();
		const at = haystack.indexOf(needle);
		if (at < 0) continue;

		let matchCount = 0;
		for (
			let cursor = haystack.indexOf(needle);
			cursor >= 0;
			cursor = haystack.indexOf(needle, cursor + needle.length)
		) {
			matchCount++;
		}

		const transcriptIndex = transcript.toLowerCase().indexOf(needle);
		matches.push({
			...sessionSummary(info),
			snippet: transcriptIndex >= 0 ? sessionSnippet(transcript, needle, transcriptIndex) : "",
			matchCount,
		});
	}

	matches.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
	return { query, matches: matches.slice(0, limit) };
}

type ThinkingLevelValue = Parameters<SettingsManager["setDefaultThinkingLevel"]>[0];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevelValue {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function splitModelThinkingKey(key: string): { provider: string; id: string } {
	const slash = key.indexOf("/");
	return slash < 0 ? { provider: key, id: "" } : { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

function settingsView(manager: SettingsManager): WebSettings {
	const modelThinkingLevels: WebSettingsModelThinkingLevel[] = Object.entries(manager.getAllModelThinkingLevels()).map(
		([key, level]) => ({ ...splitModelThinkingKey(key), level }),
	);
	const defaultProvider = manager.getDefaultProvider();
	const defaultModel = manager.getDefaultModel();
	const defaultThinkingLevel = manager.getDefaultThinkingLevel();
	return {
		...(defaultProvider ? { defaultProvider } : {}),
		...(defaultModel ? { defaultModel } : {}),
		...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
		modelThinkingLevels,
		...(manager.getEnabledModels() ? { enabledModels: manager.getEnabledModels() } : {}),
		compaction: manager.getCompactionSettings(),
		steeringMode: manager.getSteeringMode(),
		followUpMode: manager.getFollowUpMode(),
		retry: manager.getRetrySettings(),
	};
}

/** Applies a validated settings patch. Model thinking-level overrides are replaced as a set. */
function applySettingsPatch(manager: SettingsManager, body: Record<string, unknown>): void {
	if ("enabledModels" in body) {
		if (
			!Array.isArray(body.enabledModels) ||
			!body.enabledModels.every((value) => typeof value === "string" && value.trim())
		) {
			throw new HttpRequestError(400, "enabledModels must be a list of model references");
		}
		manager.setEnabledModels(body.enabledModels);
	}
	if ("defaultModel" in body) {
		const value = body.defaultModel;
		if (value !== null) {
			if (!isPlainObject(value) || typeof value.provider !== "string" || typeof value.id !== "string") {
				throw new HttpRequestError(400, "defaultModel must be { provider, id }");
			}
			manager.setDefaultModelAndProvider(value.provider, value.id);
		}
	}

	if ("defaultThinkingLevel" in body) {
		const value = body.defaultThinkingLevel;
		if (value !== null) {
			if (!isThinkingLevel(value)) throw new HttpRequestError(400, "defaultThinkingLevel is not valid");
			manager.setDefaultThinkingLevel(value);
		}
	}

	if ("modelThinkingLevels" in body) {
		const value = body.modelThinkingLevels;
		if (!Array.isArray(value)) throw new HttpRequestError(400, "modelThinkingLevels must be an array");
		const entries = value.map((entry) => {
			if (
				!isPlainObject(entry) ||
				typeof entry.provider !== "string" ||
				typeof entry.id !== "string" ||
				!isThinkingLevel(entry.level)
			) {
				throw new HttpRequestError(400, "Each modelThinkingLevels entry needs provider, id and level");
			}
			return { provider: entry.provider, id: entry.id, level: entry.level };
		});
		for (const key of Object.keys(manager.getAllModelThinkingLevels())) {
			const { provider, id } = splitModelThinkingKey(key);
			manager.removeModelThinkingLevel(provider, id);
		}
		for (const entry of entries) manager.setModelThinkingLevel(entry.provider, entry.id, entry.level);
	}

	if ("compactionEnabled" in body) {
		if (typeof body.compactionEnabled !== "boolean")
			throw new HttpRequestError(400, "compactionEnabled must be a boolean");
		manager.setCompactionEnabled(body.compactionEnabled);
	}
	if ("compactionReserveTokens" in body) {
		if (!isNonNegativeInteger(body.compactionReserveTokens))
			throw new HttpRequestError(400, "compactionReserveTokens must be a non-negative integer");
		manager.setCompactionReserveTokens(body.compactionReserveTokens);
	}
	if ("compactionKeepRecentTokens" in body) {
		if (!isNonNegativeInteger(body.compactionKeepRecentTokens))
			throw new HttpRequestError(400, "compactionKeepRecentTokens must be a non-negative integer");
		manager.setCompactionKeepRecentTokens(body.compactionKeepRecentTokens);
	}
	if ("steeringMode" in body) {
		if (body.steeringMode !== "all" && body.steeringMode !== "one-at-a-time")
			throw new HttpRequestError(400, "steeringMode is not valid");
		manager.setSteeringMode(body.steeringMode);
	}
	if ("followUpMode" in body) {
		if (body.followUpMode !== "all" && body.followUpMode !== "one-at-a-time")
			throw new HttpRequestError(400, "followUpMode is not valid");
		manager.setFollowUpMode(body.followUpMode);
	}
	if ("retryEnabled" in body) {
		if (typeof body.retryEnabled !== "boolean") throw new HttpRequestError(400, "retryEnabled must be a boolean");
		manager.setRetryEnabled(body.retryEnabled);
	}
}

function parseUsageDays(value: string | null): number {
	if (!value) return DEFAULT_USAGE_DAYS;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_USAGE_DAYS) return DEFAULT_USAGE_DAYS;
	return parsed;
}

/** Local midnight `offsetDays` before today; the usage window includes today. */
function dayStart(offsetDays: number): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays);
}

async function sessionUsage(path: string, modified: number, since: number): Promise<UsageSummary> {
	const cached = runtime().usageCache.get(path);
	if (cached && cached.modified === modified && cached.since === since) return cached.summary;
	const summary = summarizeUsage(SessionManager.open(path).getEntries(), since);
	runtime().usageCache.set(path, { modified, since, summary });
	return summary;
}

/** Aggregate usage for every project session touched within the recent window. */
async function projectUsage(days: number): Promise<WebUsage> {
	const sessions = await (sessionLister?.(runtime().cwd) ?? SessionManager.list(runtime().cwd));
	const start = dayStart(days - 1);
	const since = start.getTime();
	const models = new Map<string, WebUsageModel>();
	const daily = new Map<string, WebUsageDay>();

	const summaries: UsageSummary[] = [];
	for (const info of sessions) {
		if (info.modified.getTime() < since) continue;
		try {
			summaries.push(await sessionUsage(info.path, info.modified.getTime(), since));
		} catch {
			// A single unreadable session should not fail the whole report.
		}
	}
	for (const entries of runtime().deletedSessionUsage.values()) {
		summaries.push(summarizeUsage(entries, since));
	}
	for (const summary of summaries) {
		for (const model of summary.models) {
			const merged = models.get(model.key) ?? { key: model.key, tokens: 0, cost: 0 };
			merged.tokens += model.tokens;
			merged.cost += model.cost;
			models.set(model.key, merged);
		}
		for (const day of summary.daily) {
			const merged = daily.get(day.date) ?? { date: day.date, tokens: 0, cost: 0 };
			merged.tokens += day.tokens;
			merged.cost += day.cost;
			daily.set(day.date, merged);
		}
	}

	let totalTokens = 0;
	let totalCost = 0;
	for (const model of models.values()) {
		totalTokens += model.tokens;
		totalCost += model.cost;
	}

	// Fill every day in the window so the client renders a continuous series.
	const filled: WebUsageDay[] = [];
	for (let offset = 0; offset < days; offset++) {
		const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
		const key = localDateKey(date);
		filled.push(daily.get(key) ?? { date: key, tokens: 0, cost: 0 });
	}

	return {
		days,
		totalTokens,
		totalCost,
		models: [...models.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost),
		daily: filled,
	};
}

function runningExecutions(): WebToolExecution[] {
	return [...runtime().activeToolExecutions.values()]
		.filter((execution) => execution.status === "running")
		.map((execution) => ({ ...execution }));
}

// Completed executions already have their args/result in `messages`, so a full snapshot only
// needs the status and timing; shipping the payload again would bloat every snapshot.
function completedExecution(execution: WebToolExecution): WebToolExecution {
	return {
		toolCallId: execution.toolCallId,
		toolName: execution.toolName,
		args: execution.args,
		status: execution.status,
		...(execution.isError === undefined ? {} : { isError: execution.isError }),
		...(execution.startedAt === undefined ? {} : { startedAt: execution.startedAt }),
		...(execution.finishedAt === undefined ? {} : { finishedAt: execution.finishedAt }),
	};
}

function snapshotExecutions(): WebToolExecution[] {
	return [...runtime().activeToolExecutions.values()].map((execution) =>
		execution.status === "running" ? { ...execution } : completedExecution(execution),
	);
}

function sessionDelta(): WebSnapshotDelta {
	const currentSession = runtime().session;
	const current = currentSession?.agent.state;
	const lastMessage = current?.messages.at(-1);
	const wasAborted = lastMessage?.role === "assistant" && lastMessage.stopReason === "aborted";
	const streaming = Boolean(runtime().activePrompt) || Boolean(currentSession?.isStreaming);
	const error = runtime().promptError ?? runtime().sessionError ?? (wasAborted ? undefined : current?.errorMessage);
	const phase: WebSnapshotDelta["phase"] = !currentSession
		? "unavailable"
		: runtime().aborting
			? "stopping"
			: runtime().compacting
				? "compacting"
				: streaming
					? "streaming"
					: error
						? "error"
						: "idle";
	return {
		protocolVersion: 1,
		sequence: runtime().sequence,
		ready: currentSession !== undefined,
		cwd: runtime().cwd,
		prompting: streaming,
		phase,
		...(current?.streamingMessage === undefined ? {} : { streamingMessage: current.streamingMessage }),
		pendingToolCalls: current ? [...current.pendingToolCalls] : [],
		toolExecutions: runningExecutions(),
		...(currentSession ? { contextUsage: currentSession.getContextUsage() } : {}),
		...(currentSession ? { thinkingLevel: currentSession.thinkingLevel, sessionId: currentSession.sessionId } : {}),
		...(currentSession?.sessionName ? { sessionName: currentSession.sessionName } : {}),
		...(currentSession
			? {
					queuedMessages: {
						steering: [...currentSession.getSteeringMessages()],
						followUp: [...currentSession.getFollowUpMessages()],
					},
				}
			: {}),
		...(error ? { error } : {}),
	};
}

function sessionStatsView(): WebSessionStats | undefined {
	const currentSession = runtime().session;
	if (!currentSession) return undefined;
	const stats = currentSession.getSessionStats();
	return {
		userMessages: stats.userMessages,
		assistantMessages: stats.assistantMessages,
		toolCalls: stats.toolCalls,
		tokens: stats.tokens.total,
		cost: stats.cost,
		context: contextBreakdown(
			currentSession.agent.state.messages,
			currentSession.systemPrompt,
			stats.contextUsage?.tokens,
		),
	};
}

function sessionState(): WebSnapshot {
	const currentSession = runtime().session;
	const availableModels = currentSession?.modelRuntime.getAvailableSnapshot() ?? [];
	const enabled = currentSession?.settingsManager.getEnabledModels();
	const activeModel = currentSession?.model;
	const models =
		enabled === undefined
			? availableModels
			: availableModels.filter(
					(model) =>
						enabled.includes(`${model.provider}/${model.id}`) ||
						(model.provider === activeModel?.provider && model.id === activeModel?.id),
				);
	const thinkingLevels = currentSession?.getAvailableThinkingLevels() ?? [];
	const sessionStats = sessionStatsView();
	return {
		messages: currentSession?.agent.state.messages ?? [],
		...sessionDelta(),
		// Full snapshots list every execution so the client can keep status/timing for tools
		// whose result lives in `messages`.
		toolExecutions: snapshotExecutions(),
		git: runtime().gitState,
		...(activeModel ? { model: { provider: activeModel.provider, id: activeModel.id } } : {}),
		models: models.map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
		})),
		thinkingLevels,
		...(sessionStats ? { sessionStats } : {}),
	};
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(wireStringify(body));
}

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${wireStringify(data)}\n\n`;
}

function removeSubscriber(subscriber: SseSubscriber, destroy = false, target = runtime()): void {
	if (subscriber.closed) return;
	subscriber.closed = true;
	target.subscribers.delete(subscriber);
	clearInterval(subscriber.heartbeat);
	if (destroy && !subscriber.response.writableEnded) subscriber.response.destroy();
}

function flushSubscriber(subscriber: SseSubscriber): void {
	if (subscriber.closed || subscriber.blocked) return;
	while (subscriber.queue.length > 0) {
		const frame = subscriber.queue.shift();
		if (frame === undefined) return;
		try {
			if (!subscriber.response.write(frame)) {
				subscriber.blocked = true;
				subscriber.response.once("drain", () => {
					subscriber.blocked = false;
					flushSubscriber(subscriber);
				});
				return;
			}
		} catch {
			removeSubscriber(subscriber, true);
			return;
		}
	}
}

function enqueueSubscriber(subscriber: SseSubscriber, frame: string): void {
	if (subscriber.closed) return;
	if (subscriber.queue.length >= MAX_QUEUED_SSE_FRAMES) {
		// The client is behind. Replace the pending backlog with one full snapshot instead of
		// dropping the connection: a snapshot supersedes every queued update, so the client
		// resyncs from a single frame once it drains.
		subscriber.queue = [sseFrame("snapshot", snapshotEnvelope())];
	}
	subscriber.queue.push(frame);
	flushSubscriber(subscriber);
}

function snapshotEnvelope(): WebEventEnvelope {
	return { kind: "snapshot", snapshot: sessionState() };
}

// Events that only touch the live streaming view. Everything else (new messages, session
// changes, git refreshes) ships a full snapshot so the transcript stays in sync.
const LIGHT_EVENT_TYPES = new Set([
	"message_update",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"thinking_level_changed",
	"session_info_changed",
	"queue_update",
]);

function updateEnvelope(eventType: string): WebEventEnvelope {
	if (LIGHT_EVENT_TYPES.has(eventType)) return { kind: "update", patch: sessionDelta(), eventType };
	return { kind: "snapshot", snapshot: sessionState(), eventType };
}

function broadcast(envelope: WebEventEnvelope): void {
	const frame = sseFrame(envelope.kind, envelope);
	for (const subscriber of runtime().subscribers) enqueueSubscriber(subscriber, frame);
}

function broadcastSnapshot(): void {
	broadcast(snapshotEnvelope());
}

async function refreshGitStatus(): Promise<void> {
	const requestId = ++runtime().gitRefreshId;
	const result = await readGitStatus(runtime().cwd);
	if (requestId !== runtime().gitRefreshId) return;
	runtime().gitState = result;
	runtime().sequence += 1;
	broadcastSnapshot();
}

function broadcastUpdate(eventType: string): void {
	broadcast(updateEnvelope(eventType));
}

function updateToolExecution(event: AgentSessionEvent): void {
	if (event.type === "tool_execution_start") {
		runtime().activeToolExecutions.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			status: "running",
			startedAt: Date.now(),
		});
	} else if (event.type === "tool_execution_update") {
		const previous = runtime().activeToolExecutions.get(event.toolCallId);
		runtime().activeToolExecutions.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			status: previous?.status ?? "running",
			...(previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
			...(previous?.result === undefined ? {} : { result: previous.result }),
			partialResult: event.partialResult,
		});
	} else if (event.type === "tool_execution_end") {
		const previous = runtime().activeToolExecutions.get(event.toolCallId);
		runtime().activeToolExecutions.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: previous?.args,
			status: event.isError ? "error" : "done",
			...(previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
			finishedAt: Date.now(),
			result: event.result,
			isError: event.isError,
		});
	}
}

function subscribeToSession(nextSession: AgentSession): void {
	nextSession.subscribe((event) => {
		if (event.type === "bash_execution_update") return;
		if (event.type === "compaction_start") runtime().compacting = true;
		else if (event.type === "compaction_end") runtime().compacting = false;
		updateToolExecution(event);
		runtime().sequence += 1;
		broadcastUpdate(event.type);
	});
}

function createSessionManager(selection: SessionSelection, directory = runtime().cwd): SessionManager {
	if (selection === "recent") return SessionManager.continueRecent(directory);
	if (selection === "new") return SessionManager.create(directory);
	return SessionManager.open(selection.path, undefined, directory);
}

async function openSession(selection: SessionSelection, directory = runtime().cwd): Promise<void> {
	try {
		const created = sessionFactory
			? await sessionFactory(selection, directory)
			: (await createAgentSession({ cwd: directory, sessionManager: createSessionManager(selection, directory) }))
					.session;
		const previous = runtime().session;
		runtime().cwd = directory;
		runtime().session = created;
		runtime().sessionError = undefined;
		runtime().promptError = undefined;
		runtime().aborting = false;
		runtime().compacting = false;
		runtime().activeToolExecutions.clear();
		subscribeToSession(created);
		if (previous) previous.dispose();
		runtime().sequence += 1;
		broadcastSnapshot();
		if (previous) void refreshGitStatus();
	} catch (error) {
		if (directory === runtime().cwd) {
			runtime().sessionError = error instanceof Error ? error.message : String(error);
			broadcastSnapshot();
		}
		throw error;
	}
}

function startSessionOpen(selection: SessionSelection, directory = runtime().cwd): Promise<void> {
	const operation = openSession(selection, directory);
	runtime().sessionOperation = operation;
	operation.then(
		() => {
			if (runtime().sessionOperation === operation) runtime().sessionOperation = undefined;
		},
		() => {
			if (runtime().sessionOperation === operation) runtime().sessionOperation = undefined;
		},
	);
	return operation;
}

async function ensureSession(): Promise<AgentSession> {
	const existing = runtime().session;
	if (existing) return existing;
	if (!runtime().sessionOperation) startSessionOpen("recent");
	await runtime().sessionOperation;
	const created = runtime().session;
	if (!created) throw new Error(runtime().sessionError ?? "Unable to create an agent session");
	return created;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > MAX_REQUEST_BYTES) throw new HttpRequestError(413, "Request body is too large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new HttpRequestError(400, "Request body must be an object");
	}
	return parsed as Record<string, unknown>;
}

function isLocalUrl(value: string, expectedPort: number): boolean {
	try {
		const url = new URL(value.includes("://") ? value : `http://${value}`);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return false;
		return url.port === String(expectedPort);
	} catch {
		return false;
	}
}

function isAllowedRequest(request: IncomingMessage): boolean {
	if (!request.headers.host || !isLocalUrl(request.headers.host, port)) return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	if (origin === "null") return false;
	return isLocalUrl(origin, port);
}

function contentType(path: string): string {
	return (
		{
			".html": "text/html; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".js": "application/javascript; charset=utf-8",
			".json": "application/json; charset=utf-8",
			".svg": "image/svg+xml",
			".png": "image/png",
			".webp": "image/webp",
			".ico": "image/x-icon",
			".woff": "font/woff",
			".woff2": "font/woff2",
		}[extname(path).toLowerCase()] ?? "application/octet-stream"
	);
}

async function serveFrontend(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
	if (vite) {
		const devServer = vite;
		await new Promise<void>((resolveNext, reject) => {
			devServer.middlewares(request, response, (error?: unknown) => {
				if (error) reject(error);
				else resolveNext();
			});
		});
		if (!response.writableEnded && !response.headersSent) sendJson(response, 404, { error: "Not found" });
		return;
	}

	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(url.pathname);
	} catch {
		sendJson(response, 400, { error: "Invalid URL" });
		return;
	}
	const requestedPath = resolve(distRoot, `.${decodedPath}`);
	if (requestedPath !== distRoot && !requestedPath.startsWith(`${distRoot}${sep}`)) {
		sendJson(response, 403, { error: "Forbidden" });
		return;
	}
	let filePath = requestedPath;
	let contents: Buffer;
	try {
		contents = await readFile(filePath);
	} catch {
		filePath = pagePath;
		try {
			contents = await readFile(filePath);
		} catch {
			sendJson(response, 503, { error: "Web assets are not built" });
			return;
		}
	}
	response.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-cache" });
	if (request.method === "HEAD") response.end();
	else response.end(contents);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (!isAllowedRequest(request)) {
		sendJson(response, 403, { error: "Local requests only" });
		return;
	}
	const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

	if (url.pathname === "/events" && request.method === "GET") {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const subscriber: SseSubscriber = {
			response,
			heartbeat: setInterval(() => enqueueSubscriber(subscriber, ": keep-alive\n\n"), SSE_HEARTBEAT_MS),
			queue: [],
			blocked: false,
			closed: false,
		};
		const target = runtime();
		target.subscribers.add(subscriber);
		request.on("close", () => removeSubscriber(subscriber, false, target));
		response.on("close", () => removeSubscriber(subscriber, false, target));
		enqueueSubscriber(subscriber, sseFrame("snapshot", snapshotEnvelope()));
		return;
	}

	if (url.pathname === "/api/state" && request.method === "GET") {
		sendJson(response, 200, sessionState());
		return;
	}

	if (url.pathname === "/api/workspaces" && request.method === "GET") {
		sendJson(response, 200, { id: runtime().id, current: runtime().cwd, recent: runtime().recentWorkspaces });
		return;
	}

	if (url.pathname === "/api/workspaces" && request.method === "POST") {
		let created: WorkspaceRuntime;
		try {
			created = createAdditionalWorkspace();
		} catch (error) {
			sendJson(response, error instanceof HttpRequestError ? error.status : 500, {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		void runtimeStorage.run(created, () => startSessionOpen("recent"));
		sendJson(response, 200, { id: created.id, current: created.cwd, recent: created.recentWorkspaces });
		return;
	}

	if (url.pathname === "/api/workspace/browse" && request.method === "GET") {
		const requested = url.searchParams.get("path")?.trim();
		const target = requested ? resolve(requested) : runtime().cwd;
		try {
			await validateWorkingDirectory(target);
			const entries = await browseDirectories(target);
			const parent = dirname(target);
			sendJson(response, 200, {
				path: target,
				parent: parent === target ? null : parent,
				home: homedir(),
				entries,
			});
		} catch {
			sendJson(response, 400, { error: `Not a readable directory: ${target}` });
		}
		return;
	}

	if (url.pathname === "/api/workspace/select" && request.method === "POST") {
		if (
			runtime().sessionOperation ||
			runtime().activePrompt ||
			runtime().session?.isStreaming ||
			runtime().aborting
		) {
			sendJson(response, 409, { error: "Cannot switch workspaces while the agent is busy" });
			return;
		}
		let body: Record<string, unknown>;
		try {
			body = await readBody(request);
		} catch (error) {
			sendJson(response, error instanceof HttpRequestError ? error.status : 400, {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (typeof body.path !== "string" || !body.path.trim() || !body.path.startsWith("/")) {
			sendJson(response, 400, { error: "An absolute workspace path is required" });
			return;
		}
		const nextCwd = resolve(body.path);
		try {
			await validateWorkingDirectory(nextCwd);
		} catch (error) {
			sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (nextCwd === runtime().cwd) {
			sendJson(response, 200, { ok: true });
			return;
		}
		try {
			await startSessionOpen("recent", nextCwd);
			runtime().sessionCatalog.clear();
			runtime().usageCache.clear();
			runtime().deletedSessionUsage.clear();
			runtime().gitState = { state: "loading", files: [] };
			runtime().recentWorkspaces = [nextCwd, ...runtime().recentWorkspaces.filter((entry) => entry !== nextCwd)];
			runtime().sequence += 1;
			broadcastSnapshot();
			void refreshGitStatus();
			sendJson(response, 200, { ok: true });
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/models" && request.method === "GET") {
		sendJson(response, 200, {
			models:
				runtime()
					.session?.modelRuntime.getAvailableSnapshot()
					.map((model) => ({
						provider: model.provider,
						id: model.id,
						name: model.name,
						contextWindow: model.contextWindow,
					})) ?? [],
		});
		return;
	}

	if (url.pathname === "/api/models/refresh" && request.method === "POST") {
		if (
			runtime().sessionOperation ||
			runtime().activePrompt ||
			runtime().session?.isStreaming ||
			runtime().aborting
		) {
			sendJson(response, 409, { error: "Cannot refresh models while the agent is busy" });
			return;
		}
		const currentSession = runtime().session;
		if (!currentSession) {
			sendJson(response, 503, { error: "No active session" });
			return;
		}
		try {
			const result = await currentSession.modelRuntime.refresh({ force: true, allowNetwork: true });
			runtime().sequence += 1;
			broadcastSnapshot();
			sendJson(response, 200, {
				errors: [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`),
			});
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/sessions" && request.method === "GET") {
		try {
			sendJson(response, 200, await listSessions());
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/sessions/search" && request.method === "GET") {
		try {
			sendJson(
				response,
				200,
				await searchSessions(url.searchParams.get("q") ?? "", parseSearchLimit(url.searchParams.get("limit"))),
			);
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/files" && request.method === "GET") {
		try {
			const files = await searchProjectFiles(
				runtime().cwd,
				url.searchParams.get("q") ?? "",
				parseFileLimit(url.searchParams.get("limit")),
			);
			sendJson(response, 200, { files });
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/usage" && request.method === "GET") {
		try {
			sendJson(response, 200, await projectUsage(parseUsageDays(url.searchParams.get("days"))));
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/settings" && request.method === "GET") {
		const currentSession = runtime().session;
		if (!currentSession) {
			sendJson(response, 503, { error: "No active session" });
			return;
		}
		sendJson(response, 200, settingsView(currentSession.settingsManager));
		return;
	}

	if (url.pathname === "/api/settings" && request.method === "POST") {
		if (runtime().sessionOperation) {
			sendJson(response, 409, { error: "A session transition is already running" });
			return;
		}
		const currentSession = runtime().session;
		if (!currentSession) {
			sendJson(response, 503, { error: "No active session" });
			return;
		}
		let body: Record<string, unknown>;
		try {
			body = await readBody(request);
		} catch (error) {
			const status = error instanceof HttpRequestError ? error.status : 400;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		try {
			applySettingsPatch(currentSession.settingsManager, body);
			await currentSession.settingsManager.flush();
			runtime().sequence += 1;
			broadcastSnapshot();
			sendJson(response, 200, settingsView(currentSession.settingsManager));
		} catch (error) {
			const status = error instanceof HttpRequestError ? error.status : 500;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/git/refresh" && request.method === "POST") {
		if (runtime().sessionOperation || runtime().activePrompt || runtime().session?.isStreaming) {
			sendJson(response, 409, { error: "Cannot refresh Git while the session is busy" });
			return;
		}
		await refreshGitStatus();
		sendJson(response, 200, runtime().gitState);
		return;
	}

	if (url.pathname === "/api/git/diff" && request.method === "GET") {
		const filePath = url.searchParams.get("path");
		if (!filePath) {
			sendJson(response, 400, { error: "path is required" });
			return;
		}
		const gitState = runtime().gitState;
		if (gitState.state !== "ready" || !gitState.root) {
			sendJson(response, 409, { error: "Git status is unavailable" });
			return;
		}
		const file = gitState.files.find((entry) => entry.path === filePath);
		if (!file) {
			sendJson(response, 404, { error: "File is not in the current change list" });
			return;
		}
		const { diff, truncated } = await readGitDiff(gitState.root, filePath, file.code === "??");
		sendJson(response, 200, { path: filePath, diff, truncated });
		return;
	}

	if (url.pathname === "/api/prompt" && request.method === "POST") {
		let body: Record<string, unknown>;
		try {
			body = await readBody(request);
		} catch (error) {
			const status = error instanceof HttpRequestError ? error.status : 400;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (typeof body.text !== "string" || !body.text.trim()) {
			sendJson(response, 400, { error: "text is required" });
			return;
		}
		if (body.streamingBehavior !== undefined && body.streamingBehavior !== "steer") {
			sendJson(response, 400, { error: "streamingBehavior must be steer" });
			return;
		}
		if (runtime().sessionOperation && runtime().session) {
			sendJson(response, 409, { error: "A session transition is already running" });
			return;
		}
		let activeSession: AgentSession;
		try {
			activeSession = await ensureSession();
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (runtime().activePrompt || activeSession.isStreaming) {
			if (runtime().aborting) {
				sendJson(response, 409, { error: "Stopping the current task" });
				return;
			}
			// A submission during output waits for the current turn unless the client
			// explicitly asks to steer.
			try {
				await activeSession.prompt(body.text, {
					streamingBehavior: body.streamingBehavior === "steer" ? "steer" : "followUp",
				});
				sendJson(response, 200, { ok: true, queued: true });
			} catch (error) {
				sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		if (runtime().aborting) {
			sendJson(response, 409, { error: "Stopping the current task" });
			return;
		}
		runtime().promptError = undefined;
		runtime().activeToolExecutions.clear();
		runtime().activePrompt = { session: activeSession };
		runtime().sequence += 1;
		broadcastSnapshot();
		try {
			await activeSession.prompt(body.text);
			sendJson(response, 200, { ok: true });
		} catch (error) {
			const lastMessage = activeSession.agent.state.messages.at(-1);
			const aborted =
				runtime().aborting || (lastMessage?.role === "assistant" && lastMessage.stopReason === "aborted");
			if (aborted) {
				runtime().promptError = undefined;
				sendJson(response, 200, { ok: true, aborted: true });
			} else {
				runtime().promptError = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: runtime().promptError });
			}
		} finally {
			runtime().activePrompt = undefined;
			runtime().sequence += 1;
			broadcastSnapshot();
			void refreshGitStatus();
		}
		return;
	}

	if (url.pathname === "/api/abort" && request.method === "POST") {
		if (runtime().sessionOperation && runtime().session) {
			sendJson(response, 409, { error: "A session transition is already running" });
			return;
		}
		const currentSession = runtime().session;
		if (!currentSession || (!runtime().activePrompt && !currentSession.isStreaming)) {
			sendJson(response, 200, { ok: true });
			return;
		}
		runtime().aborting = true;
		runtime().sequence += 1;
		broadcastSnapshot();
		try {
			await currentSession.abort();
			sendJson(response, 200, { ok: true });
		} catch (error) {
			sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
		} finally {
			runtime().aborting = false;
			runtime().sequence += 1;
			broadcastSnapshot();
		}
		return;
	}

	if (url.pathname === "/api/session/delete" && request.method === "POST") {
		if (
			runtime().sessionOperation ||
			runtime().activePrompt ||
			runtime().session?.isStreaming ||
			runtime().aborting
		) {
			sendJson(response, 409, { error: "Cannot delete a session while the agent is busy" });
			return;
		}
		let body: Record<string, unknown>;
		try {
			body = await readBody(request);
		} catch (error) {
			const status = error instanceof HttpRequestError ? error.status : 400;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (typeof body.id !== "string" || !body.id) {
			sendJson(response, 400, { error: "id is required" });
			return;
		}
		if (runtime().session?.sessionId === body.id) {
			sendJson(response, 409, { error: "Cannot delete the current session" });
			return;
		}
		const selected = runtime().sessionCatalog.get(body.id);
		if (!selected) {
			sendJson(response, 404, { error: "Session not found" });
			return;
		}
		try {
			const entries = SessionManager.open(selected.path).getEntries();
			await unlink(selected.path);
			runtime().deletedSessionUsage.set(body.id, entries);
			runtime().usageCache.delete(selected.path);
			runtime().sessionCatalog.delete(body.id);
			runtime().sequence += 1;
			broadcastSnapshot();
			sendJson(response, 200, { ok: true });
		} catch (error) {
			sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/session/select" && request.method === "POST") {
		if (runtime().sessionOperation) {
			sendJson(response, 409, { error: "A session transition is already running" });
			return;
		}
		if (runtime().activePrompt || runtime().session?.isStreaming || runtime().aborting) {
			sendJson(response, 409, { error: "Cannot switch sessions while a prompt is running" });
			return;
		}
		let body: Record<string, unknown>;
		try {
			body = await readBody(request);
		} catch (error) {
			const status = error instanceof HttpRequestError ? error.status : 400;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (typeof body.id !== "string" || !body.id) {
			sendJson(response, 400, { error: "id is required" });
			return;
		}
		if (runtime().session?.sessionId === body.id) {
			sendJson(response, 200, { ok: true });
			return;
		}
		let selected = runtime().sessionCatalog.get(body.id);
		if (!selected) {
			try {
				await listSessions();
			} catch (error) {
				sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
				return;
			}
			selected = runtime().sessionCatalog.get(body.id);
		}
		if (!selected) {
			sendJson(response, 404, { error: "Session not found" });
			return;
		}
		try {
			await startSessionOpen({ path: selected.path });
			sendJson(response, 200, { ok: true });
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/session/model" && request.method === "POST") {
		if (
			runtime().sessionOperation ||
			runtime().activePrompt ||
			runtime().session?.isStreaming ||
			runtime().aborting
		) {
			sendJson(response, 409, { error: "Cannot change model while the session is busy" });
			return;
		}
		const currentSession = runtime().session;
		if (!currentSession) {
			sendJson(response, 503, { error: "No active session" });
			return;
		}
		let body: Record<string, unknown>;
		try {
			body = await readBody(request);
		} catch (error) {
			const status = error instanceof HttpRequestError ? error.status : 400;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (typeof body.provider !== "string" || typeof body.id !== "string") {
			sendJson(response, 400, { error: "provider and id are required" });
			return;
		}
		const enabled = currentSession.settingsManager.getEnabledModels();
		const activeModel = currentSession.model;
		const model = currentSession.modelRuntime
			.getAvailableSnapshot()
			.find(
				(candidate) =>
					candidate.provider === body.provider &&
					candidate.id === body.id &&
					(enabled === undefined ||
						enabled.includes(`${candidate.provider}/${candidate.id}`) ||
						(candidate.provider === activeModel?.provider && candidate.id === activeModel?.id)),
			);
		if (!model) {
			sendJson(response, 404, { error: "Model is not available" });
			return;
		}
		try {
			await currentSession.setModel(model);
			runtime().sequence += 1;
			broadcastSnapshot();
			sendJson(response, 200, { ok: true });
		} catch (error) {
			sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/session/thinking" && request.method === "POST") {
		if (
			runtime().sessionOperation ||
			runtime().activePrompt ||
			runtime().session?.isStreaming ||
			runtime().aborting
		) {
			sendJson(response, 409, { error: "Cannot change thinking level while the session is busy" });
			return;
		}
		const currentSession = runtime().session;
		if (!currentSession) {
			sendJson(response, 503, { error: "No active session" });
			return;
		}
		let body: Record<string, unknown>;
		try {
			body = await readBody(request);
		} catch (error) {
			const status = error instanceof HttpRequestError ? error.status : 400;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (typeof body.level !== "string") {
			sendJson(response, 400, { error: "level is required" });
			return;
		}
		const level = currentSession.getAvailableThinkingLevels().find((candidate) => candidate === body.level);
		if (!level) {
			sendJson(response, 400, { error: "Thinking level is not supported by the current model" });
			return;
		}
		try {
			currentSession.setThinkingLevel(level);
			runtime().sequence += 1;
			broadcastSnapshot();
			sendJson(response, 200, { ok: true });
		} catch (error) {
			sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/session/name" && request.method === "POST") {
		if (runtime().sessionOperation) {
			sendJson(response, 409, { error: "A session transition is already running" });
			return;
		}
		const currentSession = runtime().session;
		if (!currentSession) {
			sendJson(response, 503, { error: "No active session" });
			return;
		}
		let body: Record<string, unknown>;
		try {
			body = await readBody(request);
		} catch (error) {
			const status = error instanceof HttpRequestError ? error.status : 400;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (typeof body.name !== "string") {
			sendJson(response, 400, { error: "name is required" });
			return;
		}
		const name = body.name.trim();
		if (name.length > 120) {
			sendJson(response, 400, { error: "name must be 120 characters or fewer" });
			return;
		}
		try {
			currentSession.setSessionName(name);
			sendJson(response, 200, { ok: true });
		} catch (error) {
			sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	if (url.pathname === "/api/new" && request.method === "POST") {
		if (runtime().sessionOperation) {
			sendJson(response, 409, { error: "A session transition is already running" });
			return;
		}
		if (runtime().activePrompt || runtime().session?.isStreaming || runtime().aborting) {
			sendJson(response, 409, { error: "Cannot replace a running session" });
			return;
		}
		try {
			await startSessionOpen("new");
			sendJson(response, 200, { ok: true });
		} catch (error) {
			sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	// Never fall through to the SPA for API paths: an HTML 200 would parse as a failed JSON
	// response on the client and hang the caller instead of surfacing a clear error.
	if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
		sendJson(response, 404, { error: "Not found" });
		return;
	}

	if (request.method === "GET" || request.method === "HEAD") {
		await serveFrontend(request, response, url);
		return;
	}

	sendJson(response, 404, { error: "Not found" });
}

function resolveListenPort(value: number): number {
	if (!Number.isInteger(value) || value < 0 || value > 65_535) {
		throw new Error(`port must be an integer between 0 and 65535, received ${value}`);
	}
	return value;
}

function configureRuntime(options: WebServerOptions): void {
	port = resolveListenPort(options.port ?? configuredPort);
	const directory = resolve(options.cwd ?? configuredCwd);
	isDevelopment = options.mode ? options.mode === "development" : process.env.PI_WEB_MODE !== "production";
	sessionFactory = options.sessionFactory;
	sessionLister = options.sessionLister;
	initialDirectory = directory;
	for (const value of workspaceRuntimes.values()) {
		for (const subscriber of value.subscribers) removeSubscriber(subscriber, true, value);
	}
	workspaceRuntimes.clear();
	defaultWorkspaceId = randomUUID();
	const created = createWorkspaceRuntime(defaultWorkspaceId, directory);
	workspaceRuntimes.set(defaultWorkspaceId, created);
	defaultRuntime = created;
}

async function closeServer(httpServer: Server): Promise<void> {
	const runtimes = [...workspaceRuntimes.values()];
	const pendingOperations: Promise<void>[] = [];
	for (const value of runtimes) {
		value.gitRefreshId += 1;
		for (const subscriber of value.subscribers) removeSubscriber(subscriber, true, value);
		if (value.sessionOperation) pendingOperations.push(value.sessionOperation);
		value.sessionOperation = undefined;
	}
	for (const operation of pendingOperations) {
		try {
			await operation;
		} catch {
			// The initialization error is already exposed through the session snapshot.
		}
	}
	const disposed = new Set<AgentSession>();
	for (const value of runtimes) {
		const currentSession = value.session;
		value.session = undefined;
		if (currentSession && !disposed.has(currentSession)) {
			disposed.add(currentSession);
			await currentSession.dispose();
		}
	}
	if (vite) {
		await vite.close();
		vite = undefined;
	}
	await new Promise<void>((resolveClose, rejectClose) => {
		if (!httpServer.listening) {
			resolveClose();
			return;
		}
		httpServer.close((error) => {
			if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
			else resolveClose();
		});
	});
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
	configureRuntime(options);
	await validateWorkingDirectory();
	if (isDevelopment) {
		const { createServer: createViteServer } = require("vite") as { createServer: ViteCreateServer };
		vite = await createViteServer({
			root: webRoot,
			server: { middlewareMode: true },
			appType: "spa",
		});
	}

	const httpServer = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
		const headerToken =
			typeof request.headers["x-orrery-workspace"] === "string" ? request.headers["x-orrery-workspace"] : undefined;
		const token = headerToken ?? requestUrl.searchParams.get("workspace") ?? undefined;
		let selected: WorkspaceRuntime;
		try {
			selected = getWorkspace(token);
		} catch (error) {
			sendJson(response, error instanceof HttpRequestError ? error.status : 400, {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		void runtimeStorage
			.run(selected, () => handle(request, response))
			.catch((error: unknown) => {
				if (!response.headersSent)
					sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
				else response.destroy();
			});
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		httpServer.once("error", rejectListen);
		httpServer.listen(port, "127.0.0.1", () => {
			httpServer.off("error", rejectListen);
			const address = httpServer.address();
			if (address && typeof address !== "string") port = (address as AddressInfo).port;
			resolveListen();
		});
	});

	const initial = getWorkspace(defaultWorkspaceId);
	void runtimeStorage.run(initial, () => refreshGitStatus());
	void runtimeStorage
		.run(initial, () => startSessionOpen("recent"))
		.catch((error: unknown) => {
			console.error(`Agent session unavailable: ${error instanceof Error ? error.message : String(error)}`);
		});

	return {
		server: httpServer,
		port,
		close: () => closeServer(httpServer),
	};
}

async function main(): Promise<void> {
	const handle = await startWebServer();
	console.log(`Orrery Web UI: http://127.0.0.1:${handle.port}`);
	console.log(`Working directory: ${runtime().cwd}`);
	let closing = false;
	const shutdown = () => {
		if (closing) return;
		closing = true;
		void handle.close();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

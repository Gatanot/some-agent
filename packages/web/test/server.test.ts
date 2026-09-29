import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TextDecoder } from "node:util";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import type { AgentSession, SessionInfo } from "@gatanot/orrery";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@gatanot/orrery";
import { Type } from "typebox";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import type { WebEventEnvelope, WebSnapshot } from "../src/protocol.ts";
import { type SessionSelection, startWebServer, type WebServerHandle } from "../src/server.ts";

type JsonObject = Record<string, unknown>;

type SseEvent = {
	event: string;
	envelope: WebEventEnvelope;
};

interface SseConnection {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	decoder: InstanceType<typeof TextDecoder>;
	buffer: string;
}

interface Fixture {
	cwd: string;
	server: WebServerHandle;
	baseUrl: string;
	faux: FauxProviderRegistration;
	sessions: AgentSession[];
	selectionStarted?: Promise<void>;
	releaseSelection?: () => void;
	close: () => Promise<void>;
}

interface FixtureOptions {
	blockSelection?: boolean;
	git?: boolean;
}

async function readJson(response: Response): Promise<JsonObject> {
	return (await response.json()) as JsonObject;
}

async function request(
	baseUrl: string,
	path: string,
	init?: RequestInit,
): Promise<{ response: Response; body: JsonObject }> {
	const response = await fetch(`${baseUrl}${path}`, init);
	return { response, body: await readJson(response) };
}

async function waitForReady(baseUrl: string): Promise<WebSnapshot> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const response = await fetch(`${baseUrl}/api/state`);
		const snapshot = (await response.json()) as WebSnapshot;
		if (snapshot.ready) return snapshot;
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
	throw new Error("Timed out waiting for the web session");
}

async function connectSse(baseUrl: string): Promise<SseConnection> {
	const response = await fetch(`${baseUrl}/events`);
	assert.equal(response.status, 200);
	assert.ok(response.body);
	return {
		reader: response.body.getReader(),
		decoder: new TextDecoder(),
		buffer: "",
	};
}

async function nextSse(connection: SseConnection, timeoutMs = 3_000): Promise<SseEvent> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const frameEnd = connection.buffer.indexOf("\n\n");
		if (frameEnd >= 0) {
			const frame = connection.buffer.slice(0, frameEnd);
			connection.buffer = connection.buffer.slice(frameEnd + 2);
			let event = "message";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith("event: ")) event = line.slice(7);
				if (line.startsWith("data: ")) data += line.slice(6);
			}
			if (!data) continue;
			return { event, envelope: JSON.parse(data) as WebEventEnvelope };
		}

		const remaining = Math.max(1, deadline - Date.now());
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			connection.reader.read(),
			new Promise<{ timeout: true }>((resolve) => {
				timeoutId = setTimeout(() => resolve({ timeout: true }), remaining);
			}),
		]);
		if (timeoutId) clearTimeout(timeoutId);
		if ("timeout" in result) break;
		if (result.done) break;
		connection.buffer += connection.decoder.decode(result.value, { stream: true });
	}
	throw new Error("Timed out waiting for an SSE event");
}

async function waitForSse(
	connection: SseConnection,
	predicate: (event: SseEvent) => boolean,
	timeoutMs = 5_000,
): Promise<SseEvent> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const event = await nextSse(connection, Math.max(1, deadline - Date.now()));
		if (predicate(event)) return event;
	}
	throw new Error("Timed out waiting for the expected SSE event");
}

function sessionInfo(
	session: AgentSession,
	path: string,
	cwd: string,
	firstMessage: string,
	transcript = firstMessage,
): SessionInfo {
	const now = new Date();
	return {
		path,
		id: session.sessionId,
		...(session.sessionName ? { name: session.sessionName } : {}),
		cwd,
		created: now,
		modified: now,
		messageCount: session.agent.state.messages.length,
		firstMessage,
		allMessagesText: transcript,
	};
}

async function createSession(
	cwd: string,
	agentDir: string,
	modelRuntime: ModelRuntime,
	model: ReturnType<FauxProviderRegistration["getModel"]>,
	customTools: ToolDefinition[] = [],
): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are a deterministic web integration test assistant.",
	});
	await resourceLoader.reload();
	return (
		await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			tools: customTools.length > 0 ? customTools.map((tool) => tool.name) : undefined,
			noTools: customTools.length > 0 ? undefined : "all",
			customTools,
		})
	).session;
}

async function createFixture(
	responses: Parameters<FauxProviderRegistration["setResponses"]>[0],
	customTools: ToolDefinition[] = [],
	options: FixtureOptions = {},
): Promise<Fixture> {
	const cwd = await mkdtemp(join(tmpdir(), "orrery-web-test-"));
	if (options.git) {
		execFileSync("git", ["-C", cwd, "init", "-q"]);
		await writeFile(join(cwd, "tracked.txt"), "before\n");
		execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
		execFileSync("git", [
			"-C",
			cwd,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.org",
			"commit",
			"-qm",
			"base",
		]);
	}
	const faux = registerFauxProvider({
		models: [
			{ id: "web-test", name: "Web Test", reasoning: true },
			{ id: "web-test-2", name: "Web Test Two", reasoning: true },
		],
		tokensPerSecond: 40,
	});
	faux.setResponses(responses);
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider(model.provider, {
		api: model.api,
		apiKey: "faux-key",
		baseUrl: model.baseUrl,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	const primaryPath = join(cwd, "primary.jsonl");
	const secondaryPath = join(cwd, "secondary.jsonl");
	const primary = await createSession(cwd, cwd, modelRuntime, model, customTools);
	const secondary = await createSession(cwd, cwd, modelRuntime, model);
	const sessions = [primary, secondary];
	const byPath = new Map<string, AgentSession>([
		[primaryPath, primary],
		[secondaryPath, secondary],
	]);
	let notifySelectionStarted: (() => void) | undefined;
	let releaseSelection: (() => void) | undefined;
	const selectionStarted = new Promise<void>((resolve) => {
		notifySelectionStarted = resolve;
	});
	const selectionRelease = options.blockSelection
		? new Promise<void>((resolve) => {
				releaseSelection = resolve;
			})
		: undefined;
	let currentSession = primary;
	const lister = async () => [
		sessionInfo(primary, primaryPath, cwd, "primary session", "primary session\nsecret transcript marker"),
		sessionInfo(secondary, secondaryPath, cwd, "secondary session"),
	];
	const factory = async (selection: SessionSelection) => {
		if (selection !== "recent" && selection !== "new" && options.blockSelection) {
			notifySelectionStarted?.();
			await selectionRelease;
		}
		if (selection === "recent") {
			currentSession = primary;
			return primary;
		}
		if (selection === "new") {
			currentSession = secondary;
			return secondary;
		}
		const selected = byPath.get(selection.path);
		if (!selected) throw new Error("unknown test session");
		currentSession = selected;
		return selected;
	};
	const server = await startWebServer({
		cwd,
		port: 0,
		mode: "production",
		sessionFactory: factory,
		sessionLister: lister,
	});
	const baseUrl = `http://127.0.0.1:${server.port}`;
	await waitForReady(baseUrl);

	return {
		cwd,
		server,
		baseUrl,
		faux,
		sessions,
		selectionStarted: options.blockSelection ? selectionStarted : undefined,
		releaseSelection,
		close: async () => {
			await server.close();
			for (const openSession of sessions) {
				if (openSession !== currentSession) openSession.dispose();
			}
			faux.unregister();
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

test("refreshes Git status after an agent turn and on request", async () => {
	let workingDirectory = "";
	const tool: ToolDefinition = {
		name: "change_file",
		label: "Change file",
		description: "Change the tracked file.",
		parameters: Type.Object({}),
		execute: async () => {
			await writeFile(join(workingDirectory, "tracked.txt"), "after\n");
			return { content: [fauxText("file changed")], details: {} };
		},
	};
	const fixture = await createFixture(
		[fauxAssistantMessage(fauxToolCall("change_file", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")],
		[tool],
		{ git: true },
	);
	workingDirectory = fixture.cwd;
	const events = await connectSse(fixture.baseUrl);
	try {
		await waitForSse(
			events,
			(event) => event.envelope.kind === "snapshot" && event.envelope.snapshot.git.state === "ready",
		);
		const initial = await request(fixture.baseUrl, "/api/state");
		assert.equal((initial.body.git as WebSnapshot["git"]).files.length, 0);

		const prompt = await request(fixture.baseUrl, "/api/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "change tracked file" }),
		});
		assert.equal(prompt.response.status, 200);
		const changed = await waitForSse(
			events,
			(event) =>
				event.envelope.kind === "snapshot" &&
				event.envelope.snapshot.git.files.some((file) => file.path === "tracked.txt"),
		);
		assert.ok(changed.envelope.kind === "snapshot");
		assert.deepEqual(changed.envelope.snapshot.git.files, [
			{ code: " M", path: "tracked.txt", added: 1, removed: 1 },
		]);

		const diff = await request(fixture.baseUrl, `/api/git/diff?path=${encodeURIComponent("tracked.txt")}`);
		assert.equal(diff.response.status, 200);
		assert.match(String(diff.body.diff), /-before/);
		assert.match(String(diff.body.diff), /\+after/);
		assert.equal(diff.body.truncated, false);

		await writeFile(join(fixture.cwd, "external file.txt"), "external\n");
		const refreshed = await request(fixture.baseUrl, "/api/git/refresh", { method: "POST" });
		assert.equal(refreshed.response.status, 200);
		const status = refreshed.body as unknown as WebSnapshot["git"];
		assert.equal(status.files.find((file) => file.path === "external file.txt")?.code, "??");
	} finally {
		await events.reader.cancel();
		await fixture.close();
	}
});

test("streams real thinking and assistant updates over HTTP and SSE", async () => {
	const fixture = await createFixture([
		fauxAssistantMessage([fauxThinking("inspect first"), fauxText("streamed answer")]),
	]);
	const events = await connectSse(fixture.baseUrl);
	try {
		const initial = await nextSse(events);
		assert.equal(initial.event, "snapshot");
		assert.ok(initial.envelope.kind === "snapshot");
		assert.equal(initial.envelope.snapshot.ready, true);

		const prompt = fetch(`${fixture.baseUrl}/api/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "inspect" }),
		});
		const update = await waitForSse(
			events,
			(event) =>
				event.event === "update" &&
				event.envelope.kind === "update" &&
				event.envelope.eventType === "message_update" &&
				event.envelope.patch.prompting &&
				Boolean(event.envelope.patch.streamingMessage),
		);
		assert.ok(update.envelope.kind === "update");
		assert.equal(update.envelope.patch.phase, "streaming");
		const promptResponse = await prompt;
		assert.equal(promptResponse.status, 200);

		const state = await request(fixture.baseUrl, "/api/state");
		assert.equal(state.response.status, 200);
		const snapshot = state.body as unknown as WebSnapshot;
		assert.equal(snapshot.phase, "idle");
		assert.equal(
			snapshot.messages.some((message) => JSON.stringify(message).includes("streamed answer")),
			true,
		);
	} finally {
		await events.reader.cancel();
		await fixture.close();
	}
});

test("keeps tool partial results and tool failures in the live snapshot", async () => {
	const tool: ToolDefinition = {
		name: "web_probe",
		label: "Web Probe",
		description: "Probe a deterministic value.",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_toolCallId, _params, _signal, onUpdate) => {
			onUpdate?.({ content: [fauxText("partial output")], details: { stage: "partial" } });
			await new Promise((resolve) => setTimeout(resolve, 80));
			throw new Error("probe failed");
		},
	};
	const fixture = await createFixture(
		[
			fauxAssistantMessage(fauxToolCall("web_probe", { value: "x" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("after tool"),
		],
		[tool],
	);
	const events = await connectSse(fixture.baseUrl);
	try {
		await nextSse(events);
		const prompt = fetch(`${fixture.baseUrl}/api/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "probe" }),
		});
		const partial = await waitForSse(
			events,
			(event) =>
				event.envelope.kind === "update" &&
				event.envelope.eventType === "tool_execution_update" &&
				event.envelope.patch.toolExecutions.some((execution) => execution.partialResult !== undefined),
		);
		assert.ok(partial.envelope.kind === "update");
		const execution = partial.envelope.patch.toolExecutions[0];
		assert.equal(execution?.status, "running");
		assert.match(JSON.stringify(execution?.partialResult), /partial output/);
		assert.equal((await prompt).status, 200);

		const state = await request(fixture.baseUrl, "/api/state");
		const snapshot = state.body as unknown as WebSnapshot;
		assert.equal(snapshot.toolExecutions.at(-1)?.status, "error");
		assert.match(JSON.stringify(snapshot.messages), /probe failed/);
		assert.equal(
			snapshot.messages.some((message) => JSON.stringify(message).includes("after tool")),
			true,
		);
	} finally {
		await events.reader.cancel();
		await fixture.close();
	}
});

test("reports provider failures and restores a streaming snapshot after reconnect", async () => {
	let announceSecondResponse: (() => void) | undefined;
	let releaseSecondResponse: ((message: ReturnType<typeof fauxAssistantMessage>) => void) | undefined;
	const secondResponseStarted = new Promise<void>((resolve) => {
		announceSecondResponse = resolve;
	});
	const secondResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
		releaseSecondResponse = resolve;
	});
	const fixture = await createFixture([
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider failed" }),
		() => {
			announceSecondResponse?.();
			return secondResponse;
		},
	]);
	const firstEvents = await connectSse(fixture.baseUrl);
	try {
		await nextSse(firstEvents);
		const failedPrompt = await request(fixture.baseUrl, "/api/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "fail" }),
		});
		assert.equal(failedPrompt.response.status, 200);
		const failedState = await request(fixture.baseUrl, "/api/state");
		assert.match(String(failedState.body.error), /provider failed/);

		const prompt = fetch(`${fixture.baseUrl}/api/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "continue" }),
		});
		await secondResponseStarted;
		await waitForSse(firstEvents, (event) => event.envelope.kind === "snapshot" && event.envelope.snapshot.prompting);
		await firstEvents.reader.cancel();

		const reconnected = await connectSse(fixture.baseUrl);
		try {
			const snapshot = await nextSse(reconnected);
			assert.equal(snapshot.event, "snapshot");
			assert.ok(snapshot.envelope.kind === "snapshot");
			assert.equal(snapshot.envelope.snapshot.prompting, true);
			assert.equal(snapshot.envelope.snapshot.phase, "streaming");
		} finally {
			await reconnected.reader.cancel();
		}
		releaseSecondResponse?.(fauxAssistantMessage("reconnected response"));
		assert.equal((await prompt).status, 200);
	} finally {
		releaseSecondResponse?.(fauxAssistantMessage("cleanup response"));
		await firstEvents.reader.cancel();
		await fixture.close();
	}
});

test("changes only authenticated models and supported thinking levels", async () => {
	const fixture = await createFixture([fauxAssistantMessage("ok")]);
	try {
		const initial = await request(fixture.baseUrl, "/api/state");
		const initialModels = initial.body.models as Array<{ provider: string; id: string; name: string }>;
		assert.equal(initialModels.length, 2);
		assert.ok(initialModels.every((model) => model.provider === "faux"));
		const rejectedModel = await request(fixture.baseUrl, "/api/session/model", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "faux", id: "not-authenticated" }),
		});
		assert.equal(rejectedModel.response.status, 404);
		const currentModel = initial.body.model as { provider: string; id: string };
		const nextModel = initialModels.find((model) => model.id !== currentModel.id);
		assert.ok(nextModel);

		const selectedModel = await request(fixture.baseUrl, "/api/session/model", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: nextModel.provider, id: nextModel.id }),
		});
		assert.equal(selectedModel.response.status, 200);
		const afterModel = await request(fixture.baseUrl, "/api/state");
		assert.deepEqual(afterModel.body.model, { provider: nextModel.provider, id: nextModel.id });

		const levels = afterModel.body.thinkingLevels as string[];
		const currentLevel = String(afterModel.body.thinkingLevel);
		const nextLevel = levels.find((level) => level !== currentLevel);
		assert.ok(nextLevel);
		const selectedLevel = await request(fixture.baseUrl, "/api/session/thinking", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ level: nextLevel }),
		});
		assert.equal(selectedLevel.response.status, 200);
		const afterThinking = await request(fixture.baseUrl, "/api/state");
		assert.equal(afterThinking.body.thinkingLevel, nextLevel);

		const unsupported = await request(fixture.baseUrl, "/api/session/thinking", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ level: "invented" }),
		});
		assert.equal(unsupported.response.status, 400);
	} finally {
		await fixture.close();
	}
});

test("renames the active session and reports the name in state and history", async () => {
	const fixture = await createFixture([fauxAssistantMessage("ok")]);
	try {
		const renamed = await request(fixture.baseUrl, "/api/session/name", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Daily work" }),
		});
		assert.equal(renamed.response.status, 200);

		const state = await request(fixture.baseUrl, "/api/state");
		assert.equal(state.body.sessionName, "Daily work");
		const history = await request(fixture.baseUrl, "/api/sessions");
		const sessions = history.body.sessions as Array<{ id: string; name?: string }>;
		assert.equal(sessions.find((item) => item.id === fixture.sessions[0]?.sessionId)?.name, "Daily work");

		const tooLong = await request(fixture.baseUrl, "/api/session/name", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x".repeat(121) }),
		});
		assert.equal(tooLong.response.status, 400);
	} finally {
		await fixture.close();
	}
});

test("rejects cross-origin, malformed and oversized local requests", async () => {
	const fixture = await createFixture([fauxAssistantMessage("ok")]);
	try {
		const crossOrigin = await fetch(`${fixture.baseUrl}/api/state`, {
			headers: { origin: "https://attacker.example" },
		});
		assert.equal(crossOrigin.status, 403);

		const malformed = await fetch(`${fixture.baseUrl}/api/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		assert.equal(malformed.status, 400);

		const oversized = await fetch(`${fixture.baseUrl}/api/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "x".repeat(65_537) }),
		});
		assert.equal(oversized.status, 413);
	} finally {
		await fixture.close();
	}
});

test("rejects prompt and abort during a session transition, then switches sessions", async () => {
	const fixture = await createFixture([fauxAssistantMessage("ok")], [], { blockSelection: true });
	const events = await connectSse(fixture.baseUrl);
	try {
		await nextSse(events);
		const selected = fetch(`${fixture.baseUrl}/api/session/select`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: fixture.sessions[1]?.sessionId }),
		});
		await fixture.selectionStarted;

		const prompt = await request(fixture.baseUrl, "/api/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "blocked" }),
		});
		assert.equal(prompt.response.status, 409);
		assert.match(String(prompt.body.error), /transition/);

		const abort = await request(fixture.baseUrl, "/api/abort", { method: "POST" });
		assert.equal(abort.response.status, 409);
		assert.match(String(abort.body.error), /transition/);

		fixture.releaseSelection?.();
		assert.equal((await selected).status, 200);
		const state = await request(fixture.baseUrl, "/api/state");
		assert.equal(state.body.sessionId, fixture.sessions[1]?.sessionId);
	} finally {
		fixture.releaseSelection?.();
		await events.reader.cancel();
		await fixture.close();
	}
});

test("aborts an active prompt and publishes the stopped state", async () => {
	const fixture = await createFixture([
		(_context, options) =>
			new Promise((resolve) => {
				options?.signal?.addEventListener(
					"abort",
					() => resolve(fauxAssistantMessage("cancelled", { stopReason: "aborted" })),
					{ once: true },
				);
			}),
	]);
	const events = await connectSse(fixture.baseUrl);
	try {
		await nextSse(events);
		const prompt = fetch(`${fixture.baseUrl}/api/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "cancel" }),
		});
		await waitForSse(events, (event) => event.envelope.kind === "snapshot" && event.envelope.snapshot.prompting);

		const abort = await request(fixture.baseUrl, "/api/abort", { method: "POST" });
		assert.equal(abort.response.status, 200);
		assert.equal((await prompt).status, 200);
		const state = await request(fixture.baseUrl, "/api/state");
		assert.equal(state.body.prompting, false);
		assert.equal(state.body.phase, "idle");
		assert.match(JSON.stringify(state.body.messages), /aborted|Request was aborted/i);
	} finally {
		await events.reader.cancel();
		await fixture.close();
	}
});

test("queues a prompt while the agent is streaming instead of rejecting it", async () => {
	let announceStarted: (() => void) | undefined;
	let releaseFirst: ((message: ReturnType<typeof fauxAssistantMessage>) => void) | undefined;
	const firstStarted = new Promise<void>((resolve) => {
		announceStarted = resolve;
	});
	const firstResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
		releaseFirst = resolve;
	});
	const fixture = await createFixture([
		() => {
			announceStarted?.();
			return firstResponse;
		},
		fauxAssistantMessage("queued reply"),
	]);
	const events = await connectSse(fixture.baseUrl);
	try {
		await nextSse(events);
		const firstPrompt = fetch(`${fixture.baseUrl}/api/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "first" }),
		});
		await firstStarted;

		const queued = await request(fixture.baseUrl, "/api/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "second" }),
		});
		assert.equal(queued.response.status, 200);
		assert.equal(queued.body.queued, true);

		const during = await request(fixture.baseUrl, "/api/state");
		const duringSnapshot = during.body as unknown as WebSnapshot;
		assert.deepEqual(duringSnapshot.queuedMessages?.followUp, ["second"]);
		assert.deepEqual(duringSnapshot.queuedMessages?.steering, []);

		releaseFirst?.(fauxAssistantMessage("first reply"));
		assert.equal((await firstPrompt).status, 200);

		// The follow-up runs as its own turn after the first one settles.
		const deadline = Date.now() + 3_000;
		let afterSnapshot: WebSnapshot | undefined;
		while (Date.now() < deadline) {
			const after = await request(fixture.baseUrl, "/api/state");
			afterSnapshot = after.body as unknown as WebSnapshot;
			if (JSON.stringify(afterSnapshot.messages).includes("queued reply")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(afterSnapshot);
		assert.deepEqual(afterSnapshot.queuedMessages?.followUp, []);
		assert.match(JSON.stringify(afterSnapshot.messages), /queued reply/);
	} finally {
		await events.reader.cancel();
		await fixture.close();
	}
});

test("searches sessions by title and transcript content", async () => {
	const fixture = await createFixture([fauxAssistantMessage("unused")]);
	try {
		const byTitle = await request(fixture.baseUrl, "/api/sessions/search?q=primary");
		assert.equal(byTitle.response.status, 200);
		const titleMatches = byTitle.body.matches as Array<{ id: string }>;
		assert.ok(titleMatches.some((match) => match.id === fixture.sessions[0]?.sessionId));

		const byContent = await request(fixture.baseUrl, "/api/sessions/search?q=secret%20transcript");
		const contentMatches = byContent.body.matches as Array<{ id: string; snippet: string; matchCount: number }>;
		assert.equal(contentMatches.length, 1);
		assert.equal(contentMatches[0]?.id, fixture.sessions[0]?.sessionId);
		assert.match(contentMatches[0]?.snippet ?? "", /secret transcript marker/);
		assert.equal(contentMatches[0]?.matchCount, 1);

		const empty = await request(fixture.baseUrl, "/api/sessions/search?q=");
		assert.deepEqual(empty.body.matches, []);
	} finally {
		await fixture.close();
	}
});

test("reads and updates pi settings", async () => {
	const fixture = await createFixture([fauxAssistantMessage("unused")]);
	try {
		const initial = await request(fixture.baseUrl, "/api/settings");
		assert.equal(initial.response.status, 200);
		const initialSettings = initial.body as unknown as {
			retry: { enabled: boolean };
			compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
			modelThinkingLevels: unknown[];
		};
		assert.equal(initialSettings.retry.enabled, false);
		assert.equal(initialSettings.compaction.enabled, true);
		assert.deepEqual(initialSettings.modelThinkingLevels, []);

		const updated = await request(fixture.baseUrl, "/api/settings", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				defaultModel: { provider: "faux", id: "web-test" },
				defaultThinkingLevel: "high",
				compactionEnabled: false,
				compactionReserveTokens: 4096,
				modelThinkingLevels: [{ provider: "faux", id: "web-test", level: "low" }],
			}),
		});
		assert.equal(updated.response.status, 200);
		assert.equal(updated.body.defaultProvider, "faux");
		assert.equal(updated.body.defaultModel, "web-test");
		assert.equal(updated.body.defaultThinkingLevel, "high");
		assert.deepEqual(updated.body.modelThinkingLevels, [{ provider: "faux", id: "web-test", level: "low" }]);
		assert.equal((updated.body.compaction as { enabled: boolean }).enabled, false);
		assert.equal((updated.body.compaction as { reserveTokens: number }).reserveTokens, 4096);

		const invalid = await request(fixture.baseUrl, "/api/settings", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ modelThinkingLevels: [{ provider: "faux", id: "web-test", level: "invented" }] }),
		});
		assert.equal(invalid.response.status, 400);
	} finally {
		await fixture.close();
	}
});

test("lists project files for composer mentions", async () => {
	const fixture = await createFixture([fauxAssistantMessage("unused")], [], { git: true });
	try {
		const matches = await request(fixture.baseUrl, "/api/files?q=tracked");
		assert.equal(matches.response.status, 200);
		assert.deepEqual(matches.body.files, ["tracked.txt"]);

		const empty = await request(fixture.baseUrl, "/api/files");
		assert.equal(empty.response.status, 200);
		assert.ok((empty.body.files as string[]).includes("tracked.txt"));
	} finally {
		await fixture.close();
	}
});

test("reports project usage for the recent window", async () => {
	const fixture = await createFixture([fauxAssistantMessage("unused")]);
	try {
		const usage = await request(fixture.baseUrl, "/api/usage?days=3");
		assert.equal(usage.response.status, 200);
		const payload = usage.body as unknown as { days: number; daily: unknown[]; models: unknown[] };
		assert.equal(payload.days, 3);
		assert.equal(payload.daily.length, 3);
		assert.ok(Array.isArray(payload.models));
	} finally {
		await fixture.close();
	}
});

test("returns a JSON 404 instead of the SPA for unknown API paths", async () => {
	const fixture = await createFixture([fauxAssistantMessage("unused")]);
	try {
		const response = await fetch(`${fixture.baseUrl}/api/does-not-exist`);
		assert.equal(response.status, 404);
		assert.match(response.headers.get("content-type") ?? "", /application\/json/);
		assert.match(await response.text(), /Not found/);
	} finally {
		await fixture.close();
	}
});

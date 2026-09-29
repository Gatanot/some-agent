<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { PanelRightOpen, Pencil, Settings as SettingsIcon } from "@lucide/svelte";
	import Composer from "./components/Composer.svelte";
	import Inspector from "./components/Inspector.svelte";
	import SessionSidebar from "./components/SessionSidebar.svelte";
	import Settings from "./components/Settings.svelte";
	import Timeline from "./components/Timeline.svelte";
	import { lastUserPromptText, snapshotToAppState } from "./live.ts";
	import type { WebEventEnvelope, WebGitDiff, WebSessionMatch, WebSessionSearchResponse, WebSessionSummary, WebSessionsResponse, WebSnapshot } from "./protocol.ts";
	import type { AppState } from "./types.ts";

	const themeStorageKey = "orrery.theme";
	const themeColors = { light: "#f4f5f7", dark: "#17191c" } as const;
	type ThemeName = keyof typeof themeColors;
	let theme: ThemeName = currentTheme();
	let themeActionLabel = "";
	$: themeActionLabel = theme === "light" ? "Switch to dark theme" : "Switch to light theme";

	function isThemeName(value: unknown): value is ThemeName {
		return value === "light" || value === "dark";
	}

	function readThemePreference(): ThemeName | undefined {
		try {
			const stored = localStorage.getItem(themeStorageKey);
			return isThemeName(stored) ? stored : undefined;
		} catch {
			return undefined;
		}
	}

	function prefersLightTheme(): boolean {
		return window.matchMedia("(prefers-color-scheme: light)").matches;
	}

	function currentTheme(): ThemeName {
		const applied = document.documentElement.dataset.theme;
		return isThemeName(applied) ? applied : prefersLightTheme() ? "light" : "dark";
	}

	function applyTheme(next: ThemeName): void {
		document.documentElement.dataset.theme = next;
		for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", themeColors[next]);
	}

	function toggleTheme(): void {
		theme = theme === "light" ? "dark" : "light";
		try {
			localStorage.setItem(themeStorageKey, theme);
		} catch {
			// Storage can be unavailable; the page still switches for this visit.
		}
		applyTheme(theme);
	}

	function handleSystemThemeChange(): void {
		if (readThemePreference()) return;
		theme = prefersLightTheme() ? "light" : "dark";
		applyTheme(theme);
	}

	let inspectorOpen = false;
	let settingsOpen = false;
	let serverSnapshot: WebSnapshot | undefined;
	// Snapshots are applied to `latestSnapshot` immediately and rendered at most once per frame so
	// a burst of stream updates cannot force a full re-render per token.
	let latestSnapshot: WebSnapshot | undefined;
	let snapshotFrame: number | undefined;
	let sessionSummaries: WebSessionSummary[] = [];
	let sessionListRequest = 0;
	let sessionMatches: WebSessionMatch[] = [];
	let sessionSearching = false;
	let sessionSearchRequest = 0;
	let sessionSearchTimer: ReturnType<typeof setTimeout> | undefined;
	let inspectorTab: "changes" | "usage" = "changes";
	let connectionStatus: "connecting" | "connected" | "disconnected" = "connecting";
	let eventStream: EventSource | undefined;
	let draftValue = "";
	let draftSessionId: string | undefined;
	let draftBySession = new Map<string, string>();
	let sessionNameEditing = false;
	let usageRefreshToken = 0;
	let state: AppState;

	function loadingState(): AppState {
		return {
			title: "Connecting to the local agent",
			subtitle: "Syncing the current session",
			sessionId: "",
			phase: "unavailable",
			phaseLabel: connectionStatus === "disconnected" ? "Disconnected" : "Connecting",
			phaseTone: connectionStatus === "disconnected" ? "disconnected" : "idle",
			connection: connectionStatus,
			model: "Waiting for session",
			modelKey: "",
			models: [],
			thinking: "Medium",
			thinkingLevel: "medium",
			thinkingLevels: [],
			usage: "Unknown",
			messages: [],
			draft: "",
			unavailable: true,
		};
	}

	$: state = serverSnapshot
		? snapshotToAppState(serverSnapshot, connectionStatus)
		: loadingState();
	$: if (serverSnapshot?.sessionId !== draftSessionId) {
		draftSessionId = serverSnapshot?.sessionId;
		draftValue = draftSessionId ? draftBySession.get(draftSessionId) ?? "" : "";
	}

	function updateDraft(value: string): void {
		draftValue = value;
		if (draftSessionId) draftBySession = new Map(draftBySession).set(draftSessionId, value);
	}

	async function changeModel(value: string): Promise<void> {
		let selection: unknown;
		try {
			selection = JSON.parse(value);
		} catch {
			return;
		}
		if (!Array.isArray(selection) || typeof selection[0] !== "string" || typeof selection[1] !== "string") return;
		try {
			await postJson("/api/session/model", { provider: selection[0], id: selection[1] });
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	async function changeThinkingLevel(level: string): Promise<void> {
		try {
			await postJson("/api/session/thinking", { level });
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	async function renameSession(): Promise<void> {
		if (!serverSnapshot?.sessionId || sessionNameEditing) return;
		const nextName = window.prompt("Session name", state.title);
		if (nextName === null) return;
		sessionNameEditing = true;
		try {
			await postJson("/api/session/name", { name: nextName });
			await loadSessions();
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		} finally {
			sessionNameEditing = false;
		}
	}

	function logNotice(message: string): void {
		console.warn(`[orrery-web] ${message}`);
	}

	async function searchFiles(query: string): Promise<string[]> {
		const response = await fetch(`/api/files?q=${encodeURIComponent(query)}`);
		const payload = (await response.json().catch(() => ({}))) as { files?: string[]; error?: string };
		if (!response.ok) throw new Error(payload.error ?? `File search failed (${response.status})`);
		return payload.files ?? [];
	}

	function selectInspectorTab(tab: "changes" | "usage"): void {
		inspectorTab = tab;
	}

	function handleEscape(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			inspectorOpen = false;
			settingsOpen = false;
		}
	}

	function flushSnapshotFrame(): void {
		snapshotFrame = undefined;
		if (latestSnapshot !== undefined) serverSnapshot = latestSnapshot;
	}

	function receiveServerEvent(event: Event): void {
		const data = (event as MessageEvent<string>).data;
		if (typeof data !== "string") return;
		try {
			const envelope = JSON.parse(data) as WebEventEnvelope;
			if (envelope.kind === "snapshot") {
				if (envelope.snapshot.protocolVersion !== 1) return;
				latestSnapshot = envelope.snapshot;
			} else {
				if (envelope.patch.protocolVersion !== 1 || !latestSnapshot) return;
				latestSnapshot = { ...latestSnapshot, ...envelope.patch };
			}
			if (snapshotFrame === undefined) snapshotFrame = requestAnimationFrame(flushSnapshotFrame);
			if (!envelope.eventType || envelope.eventType === "session_info_changed" || envelope.eventType === "agent_end") {
				if (envelope.eventType === "agent_end") usageRefreshToken += 1;
				void loadSessions();
			}
		} catch {
			logNotice("Received an unrecognized agent state");
		}
	}

	function connectEvents(): void {
		eventStream?.close();
		connectionStatus = "connecting";
		const source = new EventSource("/events");
		eventStream = source;
		source.onopen = () => {
			if (eventStream === source) connectionStatus = "connected";
		};
		source.onerror = () => {
			if (eventStream === source) connectionStatus = "disconnected";
		};
		source.addEventListener("snapshot", receiveServerEvent);
		source.addEventListener("update", receiveServerEvent);
		void loadSessions();
	}

	async function postJson(path: string, body?: Record<string, unknown>): Promise<void> {
		const response = await fetch(path, {
			method: "POST",
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		const payload = (await response.json().catch(() => ({}))) as { error?: string };
		if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
	}

	async function loadSessions(): Promise<void> {
		const requestId = ++sessionListRequest;
		try {
			const response = await fetch("/api/sessions");
			const payload = (await response.json()) as WebSessionsResponse & { error?: string };
			if (!response.ok) throw new Error(payload.error ?? `Failed to load sessions (${response.status})`);
			if (requestId === sessionListRequest) sessionSummaries = payload.sessions;
		} catch (error) {
			if (requestId === sessionListRequest) logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	function searchSessions(query: string): void {
		if (sessionSearchTimer) clearTimeout(sessionSearchTimer);
		const trimmed = query.trim();
		if (!trimmed) {
			sessionSearchRequest += 1;
			sessionMatches = [];
			sessionSearching = false;
			return;
		}
		sessionSearching = true;
		sessionSearchTimer = setTimeout(() => {
			sessionSearchTimer = undefined;
			void runSessionSearch(trimmed);
		}, 220);
	}

	async function runSessionSearch(query: string): Promise<void> {
		const requestId = ++sessionSearchRequest;
		try {
			const response = await fetch(`/api/sessions/search?q=${encodeURIComponent(query)}`);
			const payload = (await response.json()) as WebSessionSearchResponse & { error?: string };
			if (!response.ok) throw new Error(payload.error ?? `Search failed (${response.status})`);
			if (requestId === sessionSearchRequest) sessionMatches = payload.matches;
		} catch (error) {
			if (requestId === sessionSearchRequest) {
				sessionMatches = [];
				logNotice(error instanceof Error ? error.message : String(error));
			}
		} finally {
			if (requestId === sessionSearchRequest) sessionSearching = false;
		}
	}

	async function deleteSession(id: string): Promise<void> {
		if (state.phase === "running" || state.phase === "stopping" || id === state.sessionId) return;
		const summary = sessionSummaries.find((session) => session.id === id);
		const title = summary?.name ?? summary?.firstMessage ?? "this session";
		if (!window.confirm(`Delete session “${title}”? This also removes its usage history from project totals.`)) return;
		try {
			await postJson("/api/session/delete", { id });
			await loadSessions();
			sessionMatches = sessionMatches.filter((match) => match.id !== id);
			if (inspectorTab === "usage") usageRefreshToken += 1;
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	async function selectSession(id: string): Promise<void> {
		if (state.phase === "running" || state.phase === "stopping") {
			logNotice("Wait for the current task before switching sessions");
			return;
		}
		try {
			await postJson("/api/session/select", { id });
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	async function newSession(): Promise<void> {
		if (state.phase === "running" || state.phase === "stopping") {
			logNotice("Wait for the current task before creating a session");
			return;
		}
		try {
			await postJson("/api/new");
			draftBySession = new Map(draftBySession);
			logNotice("Created a new session");
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	async function sendLivePrompt(text: string, submittedSessionId: string | undefined, streamingBehavior?: "steer"): Promise<void> {
		try {
			await postJson("/api/prompt", streamingBehavior ? { text, streamingBehavior } : { text });
		} catch (error) {
			if (submittedSessionId) {
				draftBySession = new Map(draftBySession).set(submittedSessionId, text);
				if (draftSessionId === submittedSessionId && draftValue === "") draftValue = text;
			}
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	function startPrompt(): void {
		const text = draftValue.trim();
		if (!text || !serverSnapshot?.ready || state.unavailable || state.noModel || state.connection !== "connected" || serverSnapshot.phase === "stopping") return;
		updateDraft("");
		void sendLivePrompt(text, draftSessionId, state.phase === "running" ? "steer" : undefined);
	}

	async function stopPrompt(): Promise<void> {
		try {
			await postJson("/api/abort");
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	function retryTask(): void {
		if (state.phase === "running" || state.phase === "stopping") return;
		if (!serverSnapshot?.ready) {
			connectEvents();
			return;
		}
		const prompt = lastUserPromptText(serverSnapshot);
		if (!prompt) {
			logNotice("There is no user message to retry");
			return;
		}
		void sendLivePrompt(prompt, serverSnapshot.sessionId);
	}

	function configure(): void {
		settingsOpen = true;
	}

	async function refreshGit(): Promise<void> {
		try {
			await postJson("/api/git/refresh");
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	async function loadGitDiff(path: string): Promise<WebGitDiff> {
		const response = await fetch(`/api/git/diff?path=${encodeURIComponent(path)}`);
		const payload = (await response.json().catch(() => ({}))) as {
			path?: string;
			diff?: string;
			truncated?: boolean;
			error?: string;
		};
		if (!response.ok) throw new Error(payload.error ?? `Failed to load diff (${response.status})`);
		return { path: payload.path ?? path, diff: payload.diff ?? "", truncated: payload.truncated === true };
	}

	function noticeAction(action: NonNullable<AppState["notice"]>["action"]): void {
		if (action === "new") void newSession();
		else if (action === "retry") retryTask();
		else if (action === "configure") configure();
	}

	async function copyText(value: string): Promise<boolean> {
		try {
			if (!navigator.clipboard) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(value);
			return true;
		} catch {
			return false;
		}
	}

	onMount(() => {
		applyTheme(theme);
		const themeMedia = window.matchMedia("(prefers-color-scheme: light)");
		themeMedia.addEventListener("change", handleSystemThemeChange);
		connectEvents();
		void loadSessions();
		return () => {
			themeMedia.removeEventListener("change", handleSystemThemeChange);
			if (snapshotFrame !== undefined) cancelAnimationFrame(snapshotFrame);
		};
	});

	onDestroy(() => {
		eventStream?.close();
	});
</script>

<svelte:window on:keydown={handleEscape} />

<svelte:head>
	<title>Orrery Web</title>
</svelte:head>

<div class="prototype">
		<main class="workspace">
		<SessionSidebar
			snapshot={serverSnapshot}
			sessions={sessionSummaries}
			matches={sessionMatches}
			searching={sessionSearching}
			onSessionSelect={selectSession}
			onDeleteSession={deleteSession}
			onSearch={searchSessions}
			onNewSession={newSession}
			newSessionDisabled={state.phase === "running" || state.phase === "stopping"}
		/>
		<section class="main-panel" aria-label="Session workspace">
			<header class="session-bar">
				<div class="session-title-block">
					<div class="session-title-line"><h1 class="current-title" title={state.title}>{state.title}</h1>{#if serverSnapshot?.ready}<button class="icon-button rename-button" type="button" aria-label="Rename session" title="Rename session" disabled={sessionNameEditing} on:click={renameSession}><Pencil size={14} /></button>{/if}</div>
					<div class="session-facts"><span class={`run-status ${state.phaseTone}`} aria-live="polite"><span class="status-dot" aria-hidden="true"></span>{state.phaseLabel}</span>{#if state.sessionId}<span class="session-id" title={state.sessionId}>ID {state.sessionId.slice(0, 8)}</span>{/if}<span>{state.messages.length} messages</span></div>
				</div>
				<div class="toolbar-actions"><button class="icon-button" type="button" aria-label="Open settings" title="Open settings" aria-expanded={settingsOpen} on:click={() => (settingsOpen = true)}><SettingsIcon size={17} /></button><button class="icon-button inspector-trigger" type="button" aria-label="Open inspector" title="Open inspector" aria-expanded={inspectorOpen} on:click={() => { inspectorOpen = !inspectorOpen; }}><PanelRightOpen size={17} /></button></div>
			</header>
			<Timeline state={state} onNoticeAction={noticeAction} onCopy={copyText} onReconnect={connectEvents} />
			<Composer
				state={state}
				draft={draftValue}
				onDraftChange={updateDraft}
				onSend={startPrompt}
				onStop={stopPrompt}
				onModelChange={changeModel}
				onThinkingChange={changeThinkingLevel}
				onFileSearch={searchFiles}
			/>
		</section>
		{#if inspectorOpen}<button class="inspector-backdrop" type="button" aria-label="Close inspector" on:click={() => (inspectorOpen = false)}></button>{/if}
		<Inspector state={state} snapshot={serverSnapshot} activeTab={inspectorTab} open={inspectorOpen} {connectionStatus} {theme} {themeActionLabel} onToggleTheme={toggleTheme} onClose={() => (inspectorOpen = false)} onTabSelect={selectInspectorTab} onRefreshGit={refreshGit} onGitDiff={loadGitDiff} usageRefresh={usageRefreshToken} />
		<Settings open={settingsOpen} models={state.models} onClose={() => (settingsOpen = false)} />
	</main>
</div>

<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { Pencil, Settings as SettingsIcon, X } from "@lucide/svelte";
	import Composer from "./components/Composer.svelte";
	import Inspector from "./components/Inspector.svelte";
	import SessionSidebar from "./components/SessionSidebar.svelte";
	import Settings from "./components/Settings.svelte";
	import Timeline from "./components/Timeline.svelte";
	import { lastUserPromptText, snapshotToAppState } from "./live.ts";
	import type { WebEventEnvelope, WebGitDiff, WebSessionMatch, WebSessionSearchResponse, WebSessionSummary, WebSessionsResponse, WebSnapshot } from "./protocol.ts";
	import type { AppState } from "./types.ts";
	import { clearWorkspaceId, getWorkspaceId, setWorkspaceId, workspaceEventUrl, workspaceFetch } from "./workspace.ts";

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

	let workspacePaths: string[] = [];
	let uiError = "";
	let settingsOpen = false;
	let pendingDelete: { id: string; title: string } | undefined = undefined;
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
	let inspectorTab: "changes" | "usage" = "usage";
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
		uiError = message;
		console.warn(`[orrery-web] ${message}`);
	}

	async function searchFiles(query: string): Promise<string[]> {
		const response = await workspaceFetch(`/api/files?q=${encodeURIComponent(query)}`);
		const payload = (await response.json().catch(() => ({}))) as { files?: string[]; error?: string };
		if (!response.ok) throw new Error(payload.error ?? `File search failed (${response.status})`);
		return payload.files ?? [];
	}

	function selectInspectorTab(tab: "changes" | "usage"): void {
		inspectorTab = tab;
	}

	function handleEscape(event: KeyboardEvent): void {
		if (event.key !== "Escape") return;
		if (pendingDelete) {
			pendingDelete = undefined;
			return;
		}
		settingsOpen = false;
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
		const source = new EventSource(workspaceEventUrl("/events"));
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
		void loadWorkspaces();
	}

	async function ensureWorkspace(): Promise<void> {
		if (getWorkspaceId()) {
			try {
				const response = await workspaceFetch("/api/workspaces");
				if (response.ok) return;
			} catch {
				// Fall through and try to create a fresh workspace.
			}
			clearWorkspaceId();
		}
		const created = await fetch("/api/workspaces", { method: "POST" });
		const payload = (await created.json().catch(() => ({}))) as { id?: string; error?: string };
		if (!created.ok || !payload.id) throw new Error(payload.error ?? `无法创建工作空间 (${created.status})`);
		setWorkspaceId(payload.id);
	}

	async function loadWorkspaces(): Promise<void> {
		try {
			const response = await workspaceFetch("/api/workspaces");
			const payload = (await response.json()) as { recent?: string[]; error?: string };
			if (!response.ok) throw new Error(payload.error ?? "无法读取工作空间");
			workspacePaths = payload.recent ?? [];
		} catch (error) {
			uiError = error instanceof Error ? error.message : String(error);
		}
	}

	async function selectWorkspace(path: string): Promise<void> {
		if (!path || path === serverSnapshot?.cwd) return;
		try {
			uiError = "";
			await postJson("/api/workspace/select", { path });
			sessionSummaries = [];
			sessionMatches = [];
			sessionSearchRequest += 1;
			usageRefreshToken += 1;
			await Promise.all([loadWorkspaces(), loadSessions()]);
		} catch (error) {
			uiError = error instanceof Error ? error.message : String(error);
		}
	}

	async function postJson(path: string, body?: Record<string, unknown>): Promise<void> {
		const response = await workspaceFetch(path, {
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
			const response = await workspaceFetch("/api/sessions");
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
			const response = await workspaceFetch(`/api/sessions/search?q=${encodeURIComponent(query)}`);
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

	function requestDeleteSession(id: string): void {
		if (state.phase === "running" || state.phase === "stopping" || id === state.sessionId) return;
		const summary = sessionSummaries.find((session) => session.id === id);
		const title = summary?.name ?? summary?.firstMessage ?? "this session";
		pendingDelete = { id, title };
	}

	async function confirmDeleteSession(): Promise<void> {
		const target = pendingDelete;
		if (!target) return;
		pendingDelete = undefined;
		try {
			await postJson("/api/session/delete", { id: target.id });
			await loadSessions();
			sessionMatches = sessionMatches.filter((match) => match.id !== target.id);
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
		void sendLivePrompt(text, draftSessionId);
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
		const response = await workspaceFetch(`/api/git/diff?path=${encodeURIComponent(path)}`);
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
		void (async () => {
			try {
				await ensureWorkspace();
			} catch (error) {
				uiError = error instanceof Error ? error.message : String(error);
			}
			connectEvents();
			void loadSessions();
		})();
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
			cwd={serverSnapshot?.cwd ?? ""}
			workspaces={workspacePaths}
			onWorkspaceSelect={selectWorkspace}
			snapshot={serverSnapshot}
			sessions={sessionSummaries}
			matches={sessionMatches}
			searching={sessionSearching}
			onSessionSelect={selectSession}
			onDeleteSession={requestDeleteSession}
			onSearch={searchSessions}
			onNewSession={newSession}
			newSessionDisabled={state.phase === "running" || state.phase === "stopping"}
		/>
		<section class="main-panel" aria-label="Session workspace">
			<header class="session-bar">
				<div class="session-title-block">
					<div class="session-title-line"><h1 class="current-title" title={state.title}>{state.title}</h1>{#if serverSnapshot?.ready}<button class="icon-button rename-button" type="button" aria-label="Rename session" title="Rename session" disabled={sessionNameEditing} on:click={renameSession}><Pencil size={14} /></button>{/if}</div>
					<div class="session-facts"><span class={`run-status ${state.phaseTone}`} aria-live="polite" title={state.sessionId || undefined}><span class="status-dot" aria-hidden="true"></span>{state.phaseLabel}</span><span>{state.messages.length} messages</span></div>
				</div>
				<div class="toolbar-actions"><button class="icon-button settings-trigger" type="button" aria-label="打开设置" title="打开设置" aria-expanded={settingsOpen} on:click={() => (settingsOpen = true)}><SettingsIcon size={17} /></button></div>
			</header>
			{#if uiError}<div class="ui-error" role="alert"><span>{uiError}</span><button class="icon-button" type="button" aria-label="关闭提示" on:click={() => (uiError = "")}><X size={15} /></button></div>{/if}
			<Timeline state={state} onNoticeAction={noticeAction} onCopy={copyText} onReconnect={connectEvents}>
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
			</Timeline>
		</section>
		<Inspector state={state} snapshot={serverSnapshot} activeTab={inspectorTab} {theme} {themeActionLabel} onToggleTheme={toggleTheme} onTabSelect={selectInspectorTab} onRefreshGit={refreshGit} onGitDiff={loadGitDiff} usageRefresh={usageRefreshToken} />
		<Settings open={settingsOpen} onClose={() => (settingsOpen = false)} />
		{#if pendingDelete}
			<button class="confirm-backdrop" type="button" aria-label="Cancel session deletion" on:click={() => (pendingDelete = undefined)}></button>
			<div class="confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-delete-title" aria-describedby="confirm-delete-text">
				<header class="settings-head">
					<h2 id="confirm-delete-title">Delete session</h2>
					<button class="icon-button" type="button" aria-label="Cancel session deletion" title="Cancel" on:click={() => (pendingDelete = undefined)}><X size={17} /></button>
				</header>
				<div class="confirm-body">
					<p class="confirm-text" id="confirm-delete-text">Delete “{pendingDelete.title.length > 48 ? pendingDelete.title.slice(0, 48) + "…" : pendingDelete.title}”? This also removes its usage history from project totals.</p>
					<div class="confirm-actions">
						<button class="secondary-button" type="button" on:click={() => (pendingDelete = undefined)}>Cancel</button>
						<button class="danger-button" type="button" on:click={confirmDeleteSession}>Delete session</button>
					</div>
				</div>
			</div>
		{/if}
	</main>
</div>

<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { PanelRightOpen, Pencil } from "@lucide/svelte";
	import Composer from "./components/Composer.svelte";
	import Inspector from "./components/Inspector.svelte";
	import SessionSidebar from "./components/SessionSidebar.svelte";
	import Timeline from "./components/Timeline.svelte";
	import { snapshotToAppState } from "./live.ts";
	import type { WebEventEnvelope, WebGitDiff, WebSessionSummary, WebSessionsResponse, WebSnapshot } from "./protocol.ts";
	import type { AppState } from "./types.ts";

	const themeStorageKey = "orrery.theme";
	const themeColors = { light: "#f4f5f7", dark: "#17191c" } as const;
	type ThemeName = keyof typeof themeColors;
	let theme: ThemeName = currentTheme();
	let themeActionLabel = "";
	$: themeActionLabel = theme === "light" ? "切换到深色主题" : "切换到浅色主题";

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
	let serverSnapshot: WebSnapshot | undefined;
	// Snapshots are applied to `latestSnapshot` immediately and rendered at most once per frame so
	// a burst of stream updates cannot force a full re-render per token.
	let latestSnapshot: WebSnapshot | undefined;
	let snapshotFrame: number | undefined;
	let sessionSummaries: WebSessionSummary[] = [];
	let sessionListRequest = 0;
	let inspectorTab: "changes" | "terminal" | "context" = "changes";
	let connectionStatus: "connecting" | "connected" | "disconnected" = "connecting";
	let eventStream: EventSource | undefined;
	let draftValue = "";
	let draftSessionId: string | undefined;
	let draftBySession = new Map<string, string>();
	let sessionNameEditing = false;
	let state: AppState;

	function loadingState(): AppState {
		return {
			title: "连接本地 agent",
			subtitle: "正在同步当前 session",
			sessionId: "",
			phase: "unavailable",
			phaseLabel: connectionStatus === "disconnected" ? "连接断开" : "连接中",
			phaseTone: connectionStatus === "disconnected" ? "disconnected" : "idle",
			connection: connectionStatus,
			model: "等待 session",
			modelKey: "",
			models: [],
			thinking: "中",
			thinkingLevel: "medium",
			thinkingLevels: [],
			usage: "未知",
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

	function selectInspectorTab(tab: "changes" | "terminal" | "context"): void {
		inspectorTab = tab;
	}

	function handleEscape(event: KeyboardEvent): void {
		if (event.key === "Escape") inspectorOpen = false;
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
				void loadSessions();
			}
		} catch {
			logNotice("收到无法识别的 agent 状态");
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
		if (!response.ok) throw new Error(payload.error ?? `请求失败 (${response.status})`);
	}

	async function loadSessions(): Promise<void> {
		const requestId = ++sessionListRequest;
		try {
			const response = await fetch("/api/sessions");
			const payload = (await response.json()) as WebSessionsResponse & { error?: string };
			if (!response.ok) throw new Error(payload.error ?? `加载 session 失败 (${response.status})`);
			if (requestId === sessionListRequest) sessionSummaries = payload.sessions;
		} catch (error) {
			if (requestId === sessionListRequest) logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	async function selectSession(id: string): Promise<void> {
		if (state.phase === "running" || state.phase === "stopping") {
			logNotice("当前任务结束后才能切换 session");
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
			logNotice("当前任务结束后才能新建 session");
			return;
		}
		try {
			await postJson("/api/new");
			draftBySession = new Map(draftBySession);
			logNotice("已创建新 session");
		} catch (error) {
			logNotice(error instanceof Error ? error.message : String(error));
		}
	}

	async function sendLivePrompt(text: string, submittedSessionId: string | undefined): Promise<void> {
		try {
			await postJson("/api/prompt", { text });
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
		if (!text || !serverSnapshot?.ready || state.unavailable || state.noModel || state.connection !== "connected") return;
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
		logNotice("请确认输入区中的内容后重新发送");
	}

	function configure(): void {
		logNotice("模型配置将在后续版本接入");
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
		if (!response.ok) throw new Error(payload.error ?? `读取 diff 失败 (${response.status})`);
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
			onSessionSelect={selectSession}
		/>
		<section class="main-panel" aria-label="会话工作区">
			<header class="session-bar">
				<div class="session-title-block">
					<div class="session-title-line"><h1 class="current-title" title={state.title}>{state.title}</h1>{#if serverSnapshot?.ready}<button class="icon-button rename-button" type="button" aria-label="重命名会话" title="重命名会话" disabled={sessionNameEditing} on:click={renameSession}><Pencil size={14} /></button>{/if}</div>
					<div class="session-facts"><span class={`run-status ${state.phaseTone}`} aria-live="polite"><span class="status-dot" aria-hidden="true"></span>{state.phaseLabel}</span>{#if state.sessionId}<span class="session-id" title={state.sessionId}>ID {state.sessionId.slice(0, 8)}</span>{/if}<span>{state.messages.length} 条消息</span></div>
				</div>
				<div class="toolbar-actions"><button class="icon-button inspector-trigger" type="button" aria-label="打开检查栏" title="打开检查栏" aria-expanded={inspectorOpen} on:click={() => { inspectorOpen = !inspectorOpen; }}><PanelRightOpen size={17} /></button></div>
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
			/>
		</section>
		{#if inspectorOpen}<button class="inspector-backdrop" type="button" aria-label="关闭检查栏" on:click={() => (inspectorOpen = false)}></button>{/if}
		<Inspector state={state} snapshot={serverSnapshot} activeTab={inspectorTab} open={inspectorOpen} {connectionStatus} {theme} {themeActionLabel} onToggleTheme={toggleTheme} onClose={() => (inspectorOpen = false)} onTabSelect={selectInspectorTab} onRefreshGit={refreshGit} onGitDiff={loadGitDiff} />
	</main>
</div>

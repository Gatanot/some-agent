<script lang="ts">
	import { Plus, Search } from "@lucide/svelte";
	import type { WebSessionSummary, WebSnapshot } from "../protocol.ts";

	export let snapshot: WebSnapshot | undefined;
	export let sessions: WebSessionSummary[] = [];
	export let onSessionSelect: (id: string) => void;
	export let onNewSession: () => void;
	export let newSessionDisabled = false;

	let query = "";

	function record(value: unknown): Record<string, unknown> | undefined {
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	}

	function sessionTitle(): string {
		if (snapshot?.sessionName) return snapshot.sessionName;
		const firstUser = snapshot?.messages.map(record).find((message) => message?.role === "user");
		const content = firstUser?.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map(record).map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
					: "";
		return text.trim().slice(0, 52) || (snapshot?.ready ? "当前 session" : "等待 session");
	}

	function summaryTitle(session: WebSessionSummary): string {
		return session.name || session.firstMessage.trim().slice(0, 52) || "未命名 session";
	}

	function summaryMeta(session: WebSessionSummary): string {
		return `${session.messageCount} 条消息`;
	}

	function relativeTime(value: string): string {
		const timestamp = Date.parse(value);
		if (!Number.isFinite(timestamp)) return "";
		const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
		if (minutes < 1) return "刚刚";
		if (minutes < 60) return `${minutes} 分钟前`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} 小时前`;
		const days = Math.floor(hours / 24);
		return `${days} 天前`;
	}

	$: currentTitle = snapshot ? sessionTitle() : "等待 session";
	$: currentId = snapshot?.sessionId;
	$: visibleSessions = sessions.filter((session) => {
		const needle = query.trim().toLowerCase();
		return !needle || `${summaryTitle(session)} ${session.cwd} ${session.firstMessage}`.toLowerCase().includes(needle);
	});
</script>

<aside class="sidebar" aria-label="会话导航">
	<div class="sidebar-head">
		<div class="sidebar-brand-row">
			<div class="brand"><span class="brand-mark" aria-hidden="true"><span></span></span><span class="brand-name">Orrery</span></div>
		</div>
		<div class="search-row">
			<div class="search-wrap">
				<Search size={15} aria-hidden="true" />
				<label class="visually-hidden" for="session-search">搜索会话</label>
				<input id="session-search" class="session-search" type="search" bind:value={query} placeholder="搜索会话" />
			</div>
			<button class="icon-button new-session-button" type="button" aria-label="新建会话" title="新建会话" disabled={newSessionDisabled} on:click={onNewSession}>
				<Plus size={16} strokeWidth={1.9} />
			</button>
		</div>
	</div>

	<nav class="session-list" aria-label="历史 sessions">
		{#if !snapshot}
			<div class="sidebar-placeholder">正在连接当前会话…</div>
		{:else if visibleSessions.length === 0 && !currentId}
			<div class="sidebar-placeholder">{query ? "没有匹配的会话" : "暂无历史会话"}</div>
		{:else}
			<div class="session-period">最近会话</div>
			{#each visibleSessions as session (session.id)}
				<button class:current={session.id === currentId} class="session-item" type="button" aria-current={session.id === currentId} on:click={() => onSessionSelect(session.id)}>
					<span class={`session-dot ${session.id === currentId && snapshot.prompting ? "active" : ""}`}></span>
					<span class="session-copy">
						<span class="session-title">{session.id === currentId ? currentTitle : summaryTitle(session)}</span>
						<span class="session-meta"><span>{summaryMeta(session)}</span><span>{relativeTime(session.modified)}</span></span>
					</span>
				</button>
			{/each}
			{#if currentId && !visibleSessions.some((session) => session.id === currentId)}
				<div class="session-item current" aria-current="true">
					<span class={`session-dot ${snapshot.prompting ? "active" : ""}`}></span>
					<span class="session-copy"><span class="session-title">{currentTitle}</span><span class="session-meta"><span>{snapshot.messages.length} 条消息</span><span>当前</span></span></span>
				</div>
			{/if}
		{/if}
	</nav>
</aside>

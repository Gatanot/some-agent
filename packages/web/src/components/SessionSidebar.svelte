<script lang="ts">
	import { Plus, Search } from "@lucide/svelte";
	import type { WebSessionMatch, WebSessionSummary, WebSnapshot } from "../protocol.ts";

	export let snapshot: WebSnapshot | undefined;
	export let sessions: WebSessionSummary[] = [];
	export let matches: WebSessionMatch[] = [];
	export let searching = false;
	export let onSessionSelect: (id: string) => void;
	export let onSearch: (query: string) => void;
	export let onNewSession: () => void;
	export let newSessionDisabled = false;

	let query = "";
	$: onSearch(query);

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
		return text.trim().slice(0, 52) || (snapshot?.ready ? "Current session" : "Waiting for session");
	}

	function summaryTitle(session: WebSessionSummary): string {
		return session.name || session.firstMessage.trim().slice(0, 52) || "Untitled session";
	}

	function summaryMeta(session: WebSessionSummary): string {
		return `${session.messageCount} messages`;
	}

	function relativeTime(value: string): string {
		const timestamp = Date.parse(value);
		if (!Number.isFinite(timestamp)) return "";
		const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	$: currentTitle = snapshot ? sessionTitle() : "Waiting for session";
	$: currentId = snapshot?.sessionId;
	$: needle = query.trim();
</script>

<aside class="sidebar" aria-label="Session navigation">
	<div class="sidebar-head">
		<div class="search-row">
			<div class="search-wrap">
				<Search size={15} aria-hidden="true" />
				<label class="visually-hidden" for="session-search">Search sessions</label>
				<input id="session-search" class="session-search" type="search" bind:value={query} placeholder="Search titles and transcripts" />
			</div>
			<button class="icon-button new-session-button" type="button" aria-label="New session" title="New session" disabled={newSessionDisabled} on:click={onNewSession}>
				<Plus size={16} strokeWidth={1.9} />
			</button>
		</div>
	</div>

	<nav class="session-list" aria-label="Session history">
		{#if !snapshot}
			<div class="sidebar-placeholder">Connecting to the current session…</div>
		{:else if needle}
			{#if searching && matches.length === 0}
				<div class="sidebar-placeholder">Searching…</div>
			{:else if matches.length === 0}
				<div class="sidebar-placeholder">No matching sessions</div>
			{:else}
				<div class="session-period">Results · {matches.length}</div>
				{#each matches as session (session.id)}
					<button class:current={session.id === currentId} class="session-item" type="button" aria-current={session.id === currentId} on:click={() => onSessionSelect(session.id)}>
						<span class={`session-dot ${session.id === currentId && snapshot.prompting ? "active" : ""}`}></span>
						<span class="session-copy">
							<span class="session-title">{session.id === currentId ? currentTitle : summaryTitle(session)}</span>
							{#if session.snippet}<span class="session-snippet" title={session.snippet}>{session.snippet}</span>{/if}
							<span class="session-meta"><span>{session.matchCount} matches</span><span>{relativeTime(session.modified)}</span></span>
						</span>
					</button>
				{/each}
			{/if}
		{:else if sessions.length === 0 && !currentId}
			<div class="sidebar-placeholder">No sessions yet</div>
		{:else}
			<div class="session-period">Recent</div>
			{#each sessions as session (session.id)}
				<button class:current={session.id === currentId} class="session-item" type="button" aria-current={session.id === currentId} on:click={() => onSessionSelect(session.id)}>
					<span class={`session-dot ${session.id === currentId && snapshot.prompting ? "active" : ""}`}></span>
					<span class="session-copy">
						<span class="session-title">{session.id === currentId ? currentTitle : summaryTitle(session)}</span>
						<span class="session-meta"><span>{summaryMeta(session)}</span><span>{relativeTime(session.modified)}</span></span>
					</span>
				</button>
			{/each}
			{#if currentId && !sessions.some((session) => session.id === currentId)}
				<div class="session-item current" aria-current="true">
					<span class={`session-dot ${snapshot.prompting ? "active" : ""}`}></span>
					<span class="session-copy"><span class="session-title">{currentTitle}</span><span class="session-meta"><span>{snapshot.messages.length} messages</span><span>Current</span></span></span>
				</div>
			{/if}
		{/if}
	</nav>
</aside>

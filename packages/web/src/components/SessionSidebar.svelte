<script lang="ts">
	import { Plus, Search, Trash2 } from "@lucide/svelte";
	import type { WebSessionMatch, WebSessionSummary, WebSnapshot } from "../protocol.ts";
	import SidePanel from "./SidePanel.svelte";

	export let snapshot: WebSnapshot | undefined;
	export let sessions: WebSessionSummary[] = [];
	export let matches: WebSessionMatch[] = [];
	export let searching = false;
	export let onSessionSelect: (id: string) => void;
	export let onDeleteSession: (id: string) => void;
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

<SidePanel title="Sessions" ariaLabel="Session navigation" className="panel-sessions">
	<button
		slot="actions"
		class="icon-button new-session-button"
		type="button"
		aria-label="New session"
		title="New session"
		disabled={newSessionDisabled}
		on:click={onNewSession}
	>
		<Plus size={16} strokeWidth={1.9} />
	</button>

	<div class="session-search-row">
		<div class="search-wrap">
			<Search size={14} aria-hidden="true" />
			<label class="visually-hidden" for="session-search">Search sessions</label>
			<input id="session-search" class="session-search" type="search" bind:value={query} placeholder="Search" />
		</div>
	</div>

	<nav class="session-list" aria-label="Session history">
		{#if !snapshot}
			<div class="panel-placeholder">Connecting to the current session…</div>
		{:else if needle}
			{#if searching && matches.length === 0}
				<div class="panel-placeholder">Searching…</div>
			{:else if matches.length === 0}
				<div class="panel-placeholder">No matching sessions</div>
			{:else}
				<div class="session-period">Results · {matches.length}</div>
				{#each matches as session (session.id)}
					<div class="session-entry">
						<button class:current={session.id === currentId} class="session-item" type="button" aria-current={session.id === currentId} on:click={() => onSessionSelect(session.id)}>
							<span class={`session-dot ${session.id === currentId && snapshot.prompting ? "active" : ""}`}></span>
							<span class="session-copy">
								<span class="session-title">{session.id === currentId ? currentTitle : summaryTitle(session)}</span>
								{#if session.snippet}<span class="session-snippet" title={session.snippet}>{session.snippet}</span>{/if}
								<span class="session-meta"><span>{session.matchCount} matches</span><span>{relativeTime(session.modified)}</span></span>
							</span>
						</button>
						{#if session.id !== currentId}<button class="session-delete" type="button" aria-label={`Delete ${summaryTitle(session)}`} title="Delete session" on:click={() => onDeleteSession(session.id)}><Trash2 size={14} /></button>{/if}
					</div>
				{/each}
			{/if}
		{:else if sessions.length === 0 && !currentId}
			<div class="panel-placeholder">No sessions yet</div>
		{:else}
			<div class="session-period">Recent</div>
			{#each sessions as session (session.id)}
				<div class="session-entry">
					<button class:current={session.id === currentId} class="session-item" type="button" aria-current={session.id === currentId} on:click={() => onSessionSelect(session.id)}>
						<span class={`session-dot ${session.id === currentId && snapshot.prompting ? "active" : ""}`}></span>
						<span class="session-copy">
							<span class="session-title">{session.id === currentId ? currentTitle : summaryTitle(session)}</span>
							<span class="session-meta"><span>{summaryMeta(session)}</span><span>{relativeTime(session.modified)}</span></span>
						</span>
					</button>
					{#if session.id !== currentId}<button class="session-delete" type="button" aria-label={`Delete ${summaryTitle(session)}`} title="Delete session" on:click={() => onDeleteSession(session.id)}><Trash2 size={14} /></button>{/if}
				</div>
			{/each}
			{#if currentId && !sessions.some((session) => session.id === currentId)}
				<div class="session-item current" aria-current="true">
					<span class={`session-dot ${snapshot.prompting ? "active" : ""}`}></span>
					<span class="session-copy"><span class="session-title">{currentTitle}</span><span class="session-meta"><span>{snapshot.messages.length} messages</span><span>Current</span></span></span>
				</div>
			{/if}
		{/if}
	</nav>
</SidePanel>

<style>
.session-search-row { flex: 0 0 auto; padding: 10px 10px 6px; }
.session-search-row .search-wrap { flex: 1; min-width: 0; }
.new-session-button { width: 35px; height: 35px; min-height: 35px; flex: 0 0 auto; }
.search-wrap { position: relative; }
.search-wrap > :global(svg) { position: absolute; top: 10px; left: 10px; color: var(--text-subtle); pointer-events: none; }
.session-search { width: 100%; height: 35px; padding: 5px 10px 5px 34px; border: 1px solid var(--line); border-radius: 5px; outline: 0; background: var(--surface); color: var(--text); }
.session-search:focus { border-color: var(--accent); }
.session-search::placeholder { color: var(--text-subtle); }
.session-list { min-height: 0; flex: 1; padding: 6px 9px 18px; overflow: hidden auto; scrollbar-width: none; }
.session-list::-webkit-scrollbar { display: none; }
.session-period { margin: 0 var(--space-2) 7px; color: var(--text-subtle); font-size: var(--text-xs); font-weight: 650; }
.session-entry { position: relative; display: flex; min-width: 0; align-items: stretch; }
.session-item { display: grid; grid-template-columns: 8px minmax(0, 1fr); gap: 10px; flex: 1; width: 100%; min-height: 62px; padding: 11px 9px; border: 1px solid transparent; background: transparent; text-align: left; transition: background-color .15s ease, border-color .15s ease; }
.session-item:hover { background: var(--surface-soft); }
.session-item.current { border-color: var(--line); background: var(--surface-active); }
.session-delete { position: absolute; top: 50%; right: 5px; width: 26px; height: 26px; transform: translateY(-50%); border: 1px solid var(--line); border-radius: 5px; background: var(--surface-raised); box-shadow: 0 2px 8px var(--shadow); color: var(--text-subtle); opacity: 0; pointer-events: none; transition: opacity .15s ease, background-color .15s ease, border-color .15s ease, color .15s ease; }
.session-entry:hover .session-delete, .session-delete:focus-visible { opacity: 1; pointer-events: auto; }
.session-delete:hover:not(:disabled) { border-color: var(--danger); background: var(--danger-bg); color: var(--danger); }
.session-dot { width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; background: var(--text-subtle); }
.session-item.current .session-dot { background: var(--text-muted); }
.session-dot.active { background: var(--success); }
.session-copy { min-width: 0; }
.session-title { display: block; overflow: hidden; color: var(--text); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.session-snippet { display: -webkit-box; margin-top: var(--space-1); overflow: hidden; color: var(--text-subtle); font-size: var(--text-xs); line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.session-meta { display: flex; justify-content: space-between; gap: var(--space-2); margin-top: 5px; color: var(--text-subtle); font-size: var(--text-xs); }
.session-meta span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-placeholder { padding: 22px 10px; color: var(--text-subtle); text-align: center; }
</style>

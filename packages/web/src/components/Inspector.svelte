<script lang="ts">
	import { ChartColumn, FileDiff, GitBranch, Moon, RotateCw, Sun, X } from "@lucide/svelte";
	import { parseDiffLines } from "../diff.ts";
	import type { WebContextPartKey, WebGitDiff, WebGitFile, WebSnapshot, WebUsage } from "../protocol.ts";
	import type { AppState, DiffLine } from "../types.ts";

	type InspectorTab = "changes" | "usage";
	const tabs: InspectorTab[] = ["changes", "usage"];

	export let state: AppState;
	export let snapshot: WebSnapshot | undefined;
	export let activeTab: InspectorTab;
	export let open: boolean;
	export let onClose: () => void;
	export let onTabSelect: (tab: InspectorTab) => void;
	export let onRefreshGit: () => void;
	export let onGitDiff: (path: string) => Promise<WebGitDiff>;
	export let connectionStatus: "connecting" | "connected" | "disconnected";
	export let theme: "light" | "dark";
	export let themeActionLabel: string;
	export let onToggleTheme: () => void;
	/** Incremented by the host when a turn settles, so the usage tab can refetch. */
	export let usageRefresh = 0;

	let selectedPath = "";
	let diffLines: DiffLine[] = [];
	let diffTruncated = false;
	let diffLoading = false;
	let diffError = "";
	let usage: WebUsage | undefined;
	let usageLoading = false;
	let usageError = "";
	let maxDailyTokens = 1;
	let lastUsageRefresh = -1;

	function selectTab(tab: InspectorTab): void {
		onTabSelect(tab);
		if (tab === "usage") void loadUsage();
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	function isUsage(value: unknown): value is WebUsage {
		if (!isRecord(value)) return false;
		return (
			typeof value.days === "number" &&
			typeof value.totalTokens === "number" &&
			typeof value.totalCost === "number" &&
			Array.isArray(value.models) &&
			Array.isArray(value.daily)
		);
	}

	async function loadUsage(): Promise<void> {
		if (usageLoading) return;
		usageLoading = true;
		usageError = "";
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		try {
			const response = await fetch("/api/usage", { signal: controller.signal });
			const payload: unknown = await response.json();
			if (!response.ok) {
				const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `Failed to load usage (${response.status})`;
				throw new Error(message);
			}
			if (!isUsage(payload)) throw new Error("Unexpected usage response");
			usage = payload;
		} catch (error) {
			usageError = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timeout);
			usageLoading = false;
		}
	}

	function formatTokens(value: number): string {
		if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
		if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
		return value.toLocaleString("en-US");
	}

	function barHeight(tokens: number): string {
		if (tokens === 0) return "2px";
		return `${Math.max(3, Math.round((tokens / maxDailyTokens) * 100))}%`;
	}

	function dayLabel(date: string): string {
		return date ? date.slice(5).replace("-", "/") : "";
	}

	function modelLabel(key: string): string {
		return key === "Tools/summaries" ? "Tools & summaries" : key;
	}

	function handleTabKeydown(event: KeyboardEvent, current: InspectorTab): void {
		const index = tabs.indexOf(current);
		let next: InspectorTab | undefined;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") next = tabs[(index + 1) % tabs.length];
		else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = tabs[(index - 1 + tabs.length) % tabs.length];
		else if (event.key === "Home") next = tabs[0];
		else if (event.key === "End") next = tabs[tabs.length - 1];
		if (!next) return;
		event.preventDefault();
		selectTab(next);
		(event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLButtonElement>(`#inspector-tab-${next}`)?.focus();
	}

	function contextLabel(key: WebContextPartKey): string {
		switch (key) {
			case "config":
				return "Config (AGENTS.md)";
			case "user":
				return "User input";
			case "tools":
				return "Tool results";
			case "assistant":
				return "Model output";
		}
	}

	function contextPercent(tokens: number): number {
		if (contextTotal <= 0) return 0;
		return (tokens / contextTotal) * 100;
	}

	function contextUsageText(): string {
		if (!contextUsage) return "unknown";
		if (contextUsage.tokens === null) return "available after the next response";
		const window = `${formatTokens(contextUsage.tokens)} / ${formatTokens(contextUsage.contextWindow)}`;
		return contextUsage.percent === null ? window : `${window} (${contextUsage.percent.toFixed(1)}%)`;
	}

	function statusName(file: WebGitFile): string {
		const code = file.code;
		if (code === "??") return "Untracked";
		if (code.includes("U") || code === "AA" || code === "DD") return "Conflict";
		if (code.includes("D")) return "Deleted";
		if (code.includes("R")) return "Renamed";
		if (code.includes("C")) return "Copied";
		if (code.includes("A")) return "Added";
		if (code.includes("M")) return "Modified";
		return "Changed";
	}

	async function selectFile(file: WebGitFile): Promise<void> {
		if (selectedPath === file.path) {
			selectedPath = "";
			diffLines = [];
			diffError = "";
			return;
		}
		selectedPath = file.path;
		diffLines = [];
		diffTruncated = false;
		diffError = "";
		diffLoading = true;
		try {
			const result = await onGitDiff(file.path);
			if (selectedPath !== file.path) return;
			diffLines = parseDiffLines(result.diff);
			diffTruncated = result.truncated;
		} catch (error) {
			if (selectedPath === file.path) diffError = error instanceof Error ? error.message : String(error);
		} finally {
			if (selectedPath === file.path) diffLoading = false;
		}
	}

	$: git = snapshot?.git ?? { state: "loading" as const, files: [] };
	$: if (selectedPath && git.state === "ready" && !git.files.some((file) => file.path === selectedPath)) {
		selectedPath = "";
		diffLines = [];
		diffError = "";
	}
	$: contextParts = snapshot?.sessionStats?.context ?? [];
	$: contextTotal = contextParts.reduce((sum, part) => sum + part.tokens, 0);
	$: contextUsage = snapshot?.contextUsage;
	$: maxDailyTokens = Math.max(1, ...(usage?.daily.map((day) => day.tokens) ?? []));
	$: if (usageRefresh !== lastUsageRefresh) {
		lastUsageRefresh = usageRefresh;
		if (activeTab === "usage") void loadUsage();
	}
</script>

<aside class:open class="inspector" aria-label="Project inspector">
	<div class="inspector-heading">
		<span>Project</span>
		<div class="inspector-actions">
			<span class:offline={connectionStatus === "disconnected"} class="connection-chip"><span class="status-dot" aria-hidden="true"></span>{connectionStatus === "connected" ? "Connected" : connectionStatus === "connecting" ? "Connecting" : "Disconnected"}</span>
			<button class="icon-button theme-toggle" type="button" aria-label={themeActionLabel} title={themeActionLabel} on:click={onToggleTheme}>{#if theme === "light"}<Moon size={15} />{:else}<Sun size={15} />{/if}</button>
			{#if activeTab === "changes"}<button class="icon-button" type="button" aria-label="Refresh Git status" title="Refresh Git status" disabled={git.state === "loading" || state.phase === "running"} on:click={onRefreshGit}><RotateCw size={15} /></button>{:else if activeTab === "usage"}<button class="icon-button" type="button" aria-label="Refresh usage" title="Refresh usage" disabled={usageLoading} on:click={loadUsage}><RotateCw size={15} /></button>{/if}
			<button class="icon-button inspector-close" type="button" aria-label="Close inspector" title="Close inspector" on:click={onClose}><X size={17} /></button>
		</div>
	</div>
	<div class="inspector-tabs" role="tablist" aria-label="Project inspector">
		<button id="inspector-tab-changes" class:active={activeTab === "changes"} type="button" role="tab" aria-selected={activeTab === "changes"} aria-controls="inspector-body" tabindex={activeTab === "changes" ? 0 : -1} on:click={() => selectTab("changes")} on:keydown={(event) => handleTabKeydown(event, "changes")}>
			<FileDiff size={16} strokeWidth={1.8} aria-hidden="true" /><span>Git</span>{#if git.state === "ready"}<small>{git.files.length}</small>{/if}
		</button>
		<button id="inspector-tab-usage" class:active={activeTab === "usage"} type="button" role="tab" aria-selected={activeTab === "usage"} aria-controls="inspector-body" tabindex={activeTab === "usage" ? 0 : -1} on:click={() => selectTab("usage")} on:keydown={(event) => handleTabKeydown(event, "usage")}>
			<ChartColumn size={16} strokeWidth={1.8} aria-hidden="true" /><span>Usage</span>
		</button>
	</div>

	<div class="inspector-body" id="inspector-body" role="tabpanel" aria-labelledby={`inspector-tab-${activeTab}`}>
		{#if activeTab === "changes"}
			{#if git.state === "loading"}
				<section class="inspector-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>Reading Git status</strong></section>
			{:else if git.state === "unavailable"}
				<section class="inspector-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>Not a Git repository</strong></section>
			{:else if git.state === "error"}
				<section class="inspector-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>Could not read Git status</strong><span class="git-error">{git.error}</span></section>
			{:else}
				<div class="git-summary"><GitBranch size={15} /><span class="git-branch" title={git.root}>{git.branch}</span><span class="git-total">{git.files.length} files</span></div>
				{#if git.files.length === 0}
					<section class="inspector-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>No uncommitted changes</strong></section>
				{:else}
					<div class="git-overview"><span>Modified {git.files.filter((file) => file.code.includes("M")).length}</span><span>U untracked {git.files.filter((file) => file.code === "??").length}</span></div>
					<div class="git-files">
						{#each git.files as file (`${file.code}:${file.path}`)}
							<button class:selected={selectedPath === file.path} class="git-file" type="button" aria-expanded={selectedPath === file.path} aria-controls="git-diff-panel" on:click={() => selectFile(file)}>
								<span class="git-file-detail"><span class="git-path" title={file.path}>{file.path}</span>{#if file.previousPath}<span class="git-previous" title={file.previousPath}>Previous: {file.previousPath}</span>{/if}</span>
								<span class="git-file-meta">
									{#if statusName(file) === "Untracked"}
										<span class="git-flag untracked" title={statusName(file)} aria-label={statusName(file)}>U</span>
									{:else if statusName(file) === "Conflict"}
										<span class="git-flag conflict" title={statusName(file)} aria-label={statusName(file)}>!</span>
									{:else if file.added !== undefined || file.removed !== undefined}
										<span class="git-stat"><ins>+{file.added ?? 0}</ins><del>-{file.removed ?? 0}</del></span>
									{/if}
								</span>
							</button>
						{/each}
					</div>
					{#if selectedPath}
						<section class="git-diff" id="git-diff-panel" aria-label="File diff">
							<div class="git-diff-head"><code title={selectedPath}>{selectedPath}</code></div>
							{#if diffLoading}
								<div class="git-diff-note">Reading…</div>
							{:else if diffError}
								<div class="git-diff-note error">{diffError}</div>
							{:else if diffLines.length === 0}
								<div class="git-diff-note">No diff</div>
							{:else}
								<pre class="git-diff-view">{#each diffLines as line, index (index)}<span class={`diff-line ${line.kind}`}>{line.text}</span>{/each}</pre>
								{#if diffTruncated}<div class="git-diff-note">Truncated to the first 256 KB.</div>{/if}
							{/if}
						</section>
					{/if}
				{/if}
			{/if}
		{:else}
			{@const session = snapshot?.sessionStats}
			{#if session}
				<section class="session-block" aria-label="Current session usage">
					<div class="session-heading"><span>This session</span><span class="session-counts">{session.userMessages} prompts · {session.toolCalls} tool calls</span></div>
					{#if contextTotal > 0}
						<div class="context-bar" role="img" aria-label="Estimated context composition">
							{#each contextParts as part (part.key)}
								<span class={`context-segment ${part.key}`} style={`width: ${contextPercent(part.tokens)}%`} title={`${contextLabel(part.key)}: ${formatTokens(part.tokens)} tokens`}></span>
							{/each}
						</div>
						<div class="context-legend">
							{#each contextParts as part (part.key)}
								<div class="context-item"><span class={`context-dot ${part.key}`} aria-hidden="true"></span><span class="context-name">{contextLabel(part.key)}</span><span class="context-value">{Math.round(contextPercent(part.tokens))}% · {formatTokens(part.tokens)}</span></div>
							{/each}
						</div>
					{/if}
					<div class="session-foot"><span class="session-context-label">Context {contextUsageText()}</span><span class="session-token-total">{formatTokens(session.tokens)} tokens{#if session.cost > 0}<small>${session.cost.toFixed(2)}</small>{/if}</span></div>
				</section>
			{/if}
			{#if usageError}
				<section class="inspector-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>Could not load usage</strong><span class="git-error">{usageError}</span></section>
			{:else if !usage}
				<section class="inspector-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>Calculating usage</strong></section>
			{:else if usage.models.length === 0}
				<section class="inspector-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>No usage in the last {usage.days} days</strong></section>
			{:else}
				<div class="usage-summary">
					<span class="usage-range">This project · {usage.days} days</span>
					<span class="usage-total">{formatTokens(usage.totalTokens)} tokens</span>
					{#if usage.totalCost > 0}<span class="usage-cost">${usage.totalCost.toFixed(2)}</span>{/if}
				</div>
				<div class="usage-days" aria-label={`Daily token usage for the last ${usage.days} days`}>
					{#each usage.daily as day (day.date)}
						<span class="usage-day" title={`${day.date} · ${day.tokens.toLocaleString("en-US")} tokens`}><span class:empty={day.tokens === 0} class="usage-bar" style={`height: ${barHeight(day.tokens)}`}></span></span>
					{/each}
				</div>
				<div class="usage-axis"><span>{dayLabel(usage.daily[0]?.date ?? "")}</span><span>{dayLabel(usage.daily[usage.daily.length - 1]?.date ?? "")}</span></div>
				<div class="usage-models">
					{#each usage.models as model (model.key)}
						<div class="usage-model"><span class="usage-model-key" title={model.key}>{modelLabel(model.key)}</span><span class="usage-model-value">{formatTokens(model.tokens)}{#if model.cost > 0}<small>${model.cost.toFixed(2)}</small>{/if}</span></div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</aside>

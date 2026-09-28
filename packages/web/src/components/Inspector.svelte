<script lang="ts">
	import { ChartColumn, ChevronDown, FileDiff, GitBranch, Moon, RotateCw, Sun, Terminal, X } from "@lucide/svelte";
	import { parseDiffLines } from "../diff.ts";
	import type { WebGitDiff, WebGitFile, WebSnapshot, WebUsage } from "../protocol.ts";
	import type { AppState, DiffLine, Tool } from "../types.ts";

	type InspectorTab = "changes" | "terminal" | "usage";
	const tabs: InspectorTab[] = ["changes", "terminal", "usage"];

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
				const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `加载用量失败 (${response.status})`;
				throw new Error(message);
			}
			if (!isUsage(payload)) throw new Error("用量响应格式不正确");
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
		return key === "Tools/summaries" ? "工具与摘要" : key;
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

	function outputText(tool: Tool): string {
		return Array.isArray(tool.output) ? tool.output.map((line) => line.text).join("\n") : tool.output;
	}

	function statusName(file: WebGitFile): string {
		const code = file.code;
		if (code === "??") return "未跟踪";
		if (code.includes("U") || code === "AA" || code === "DD") return "冲突";
		if (code.includes("D")) return "删除";
		if (code.includes("R")) return "重命名";
		if (code.includes("C")) return "复制";
		if (code.includes("A")) return "新增";
		if (code.includes("M")) return "修改";
		return "变更";
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
	$: terminalTools = state.messages
		.flatMap((message) => message.tools ?? [])
		.filter((tool) => ["bash", "shell", "exec"].includes(tool.name))
		.reverse(); // newest command first
	$: maxDailyTokens = Math.max(1, ...(usage?.daily.map((day) => day.tokens) ?? []));
	$: if (usageRefresh !== lastUsageRefresh) {
		lastUsageRefresh = usageRefresh;
		if (activeTab === "usage") void loadUsage();
	}
</script>

<aside class:open class="inspector" aria-label="项目检查栏">
	<div class="inspector-heading">
		<span>项目检查</span>
		<div class="inspector-actions">
			<span class:offline={connectionStatus === "disconnected"} class="connection-chip"><span class="status-dot" aria-hidden="true"></span>{connectionStatus === "connected" ? "已连接" : connectionStatus === "connecting" ? "连接中" : "已断开"}</span>
			<button class="icon-button theme-toggle" type="button" aria-label={themeActionLabel} title={themeActionLabel} on:click={onToggleTheme}>{#if theme === "light"}<Moon size={15} />{:else}<Sun size={15} />{/if}</button>
			{#if activeTab === "changes"}<button class="icon-button" type="button" aria-label="刷新 Git 状态" title="刷新 Git 状态" disabled={git.state === "loading" || state.phase === "running"} on:click={onRefreshGit}><RotateCw size={15} /></button>{:else if activeTab === "usage"}<button class="icon-button" type="button" aria-label="刷新用量" title="刷新用量" disabled={usageLoading} on:click={loadUsage}><RotateCw size={15} /></button>{/if}
			<button class="icon-button inspector-close" type="button" aria-label="关闭检查栏" title="关闭检查栏" on:click={onClose}><X size={17} /></button>
		</div>
	</div>
	<div class="inspector-tabs" role="tablist" aria-label="项目检查">
		<button id="inspector-tab-changes" class:active={activeTab === "changes"} type="button" role="tab" aria-selected={activeTab === "changes"} aria-controls="inspector-body" tabindex={activeTab === "changes" ? 0 : -1} on:click={() => selectTab("changes")} on:keydown={(event) => handleTabKeydown(event, "changes")}>
			<FileDiff size={16} strokeWidth={1.8} aria-hidden="true" /><span>Git</span>{#if git.state === "ready"}<small>{git.files.length}</small>{/if}
		</button>
		<button id="inspector-tab-terminal" class:active={activeTab === "terminal"} type="button" role="tab" aria-selected={activeTab === "terminal"} aria-controls="inspector-body" tabindex={activeTab === "terminal" ? 0 : -1} on:click={() => selectTab("terminal")} on:keydown={(event) => handleTabKeydown(event, "terminal")}>
			<Terminal size={16} strokeWidth={1.8} aria-hidden="true" /><span>命令记录</span><small>{terminalTools.length}</small>
		</button>
		<button id="inspector-tab-usage" class:active={activeTab === "usage"} type="button" role="tab" aria-selected={activeTab === "usage"} aria-controls="inspector-body" tabindex={activeTab === "usage" ? 0 : -1} on:click={() => selectTab("usage")} on:keydown={(event) => handleTabKeydown(event, "usage")}>
			<ChartColumn size={16} strokeWidth={1.8} aria-hidden="true" /><span>项目用量</span>
		</button>
	</div>

	<div class="inspector-body" id="inspector-body" role="tabpanel" aria-labelledby={`inspector-tab-${activeTab}`}>
		{#if activeTab === "changes"}
			{#if git.state === "loading"}
				<section class="inspector-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>正在读取 Git 状态</strong></section>
			{:else if git.state === "unavailable"}
				<section class="inspector-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>当前目录不是 Git 仓库</strong></section>
			{:else if git.state === "error"}
				<section class="inspector-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>无法读取 Git 状态</strong><span class="git-error">{git.error}</span></section>
			{:else}
				<div class="git-summary"><GitBranch size={15} /><span class="git-branch" title={git.root}>{git.branch}</span><span class="git-total">{git.files.length} 个文件</span></div>
				{#if git.files.length === 0}
					<section class="inspector-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>工作区无未提交变更</strong></section>
				{:else}
					<div class="git-overview"><span>修改 {git.files.filter((file) => file.code.includes("M")).length}</span><span>U 未跟踪 {git.files.filter((file) => file.code === "??").length}</span></div>
					<div class="git-files">
						{#each git.files as file (`${file.code}:${file.path}`)}
							<button class:selected={selectedPath === file.path} class="git-file" type="button" aria-expanded={selectedPath === file.path} aria-controls="git-diff-panel" on:click={() => selectFile(file)}>
								<span class="git-file-detail"><span class="git-path" title={file.path}>{file.path}</span>{#if file.previousPath}<span class="git-previous" title={file.previousPath}>原路径: {file.previousPath}</span>{/if}</span>
								<span class="git-file-meta">
									{#if statusName(file) === "未跟踪"}
										<span class="git-flag untracked" title={statusName(file)} aria-label={statusName(file)}>U</span>
									{:else if statusName(file) === "冲突"}
										<span class="git-flag conflict" title={statusName(file)} aria-label={statusName(file)}>!</span>
									{:else if file.added !== undefined || file.removed !== undefined}
										<span class="git-stat"><ins>+{file.added ?? 0}</ins><del>-{file.removed ?? 0}</del></span>
									{/if}
								</span>
							</button>
						{/each}
					</div>
					{#if selectedPath}
						<section class="git-diff" id="git-diff-panel" aria-label="文件 diff">
							<div class="git-diff-head"><code title={selectedPath}>{selectedPath}</code></div>
							{#if diffLoading}
								<div class="git-diff-note">正在读取…</div>
							{:else if diffError}
								<div class="git-diff-note error">{diffError}</div>
							{:else if diffLines.length === 0}
								<div class="git-diff-note">无差异</div>
							{:else}
								<pre class="git-diff-view">{#each diffLines as line, index (index)}<span class={`diff-line ${line.kind}`}>{line.text}</span>{/each}</pre>
								{#if diffTruncated}<div class="git-diff-note">内容已截断，只显示前 256 KB。</div>{/if}
							{/if}
						</section>
					{/if}
				{/if}
			{/if}
		{:else if activeTab === "terminal"}
			{#if terminalTools.length === 0}
				<section class="inspector-empty"><Terminal size={24} strokeWidth={1.5} /><strong>暂无命令记录</strong></section>
			{:else}
				<div class="terminal-log">
					{#each terminalTools as tool (tool.id)}
						<details class="terminal-entry"><summary class="terminal-command"><span class:error={tool.status === "error"} class="terminal-prompt">$</span><code title={tool.target}>{tool.target || tool.name}</code><span class={`mini-status ${tool.status}`}>{tool.statusText}</span><ChevronDown size={14} class="terminal-caret" aria-hidden="true" /></summary><pre class="terminal-output">{outputText(tool) || "(无输出)"}</pre></details>
					{/each}
				</div>
			{/if}
		{:else}
			{#if usageError}
				<section class="inspector-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>无法读取用量</strong><span class="git-error">{usageError}</span></section>
			{:else if !usage}
				<section class="inspector-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>正在统计用量</strong></section>
			{:else if usage.models.length === 0}
				<section class="inspector-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>最近 {usage.days} 天没有用量</strong></section>
			{:else}
				<div class="usage-summary">
					<span class="usage-range">最近 {usage.days} 天</span>
					<span class="usage-total">{formatTokens(usage.totalTokens)} tokens</span>
					{#if usage.totalCost > 0}<span class="usage-cost">${usage.totalCost.toFixed(2)}</span>{/if}
				</div>
				<div class="usage-days" aria-label={`最近 ${usage.days} 天每日 token 用量`}>
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

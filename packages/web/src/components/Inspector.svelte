<script lang="ts">
	import { ChevronDown, FileDiff, GitBranch, Info, Moon, RotateCw, Sun, Terminal, X } from "@lucide/svelte";
	import { parseDiffLines } from "../diff.ts";
	import type { WebGitDiff, WebGitFile, WebSnapshot } from "../protocol.ts";
	import type { AppState, DiffLine, Tool } from "../types.ts";

	type InspectorTab = "changes" | "terminal" | "context";
	const tabs: InspectorTab[] = ["changes", "terminal", "context"];

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

	let selectedPath = "";
	let diffLines: DiffLine[] = [];
	let diffTruncated = false;
	let diffLoading = false;
	let diffError = "";

	function handleTabKeydown(event: KeyboardEvent, current: InspectorTab): void {
		const index = tabs.indexOf(current);
		let next: InspectorTab | undefined;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") next = tabs[(index + 1) % tabs.length];
		else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = tabs[(index - 1 + tabs.length) % tabs.length];
		else if (event.key === "Home") next = tabs[0];
		else if (event.key === "End") next = tabs[tabs.length - 1];
		if (!next) return;
		event.preventDefault();
		onTabSelect(next);
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

	function statusSymbol(file: WebGitFile): string {
		const name = statusName(file);
		if (name === "未跟踪") return "N";
		if (name === "删除") return "-";
		if (name === "新增") return "+";
		if (name === "重命名") return "R";
		if (name === "冲突") return "!";
		if (name === "复制") return "C";
		if (name === "修改") return "+-";
		return "?";
	}

	function stageName(file: WebGitFile): string {
		if (file.code === "??") return "";
		const staged = file.code[0] !== " ";
		const unstaged = file.code[1] !== " ";
		return staged && unstaged ? "两处" : staged ? "暂存" : "工作区";
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
	$: terminalTools = state.messages.flatMap((message) => message.tools ?? []).filter((tool) => ["bash", "shell", "exec"].includes(tool.name));
	$: contextItems = [
		["工作目录", snapshot?.cwd ?? "未知"],
		["会话 ID", snapshot?.sessionId ?? "未知"],
		["当前模型", state.model],
		["思考等级", state.thinking],
		["最近用量", state.usage],
	];
</script>

<aside class:open class="inspector" aria-label="项目检查栏">
	<div class="inspector-heading">
		<span>项目检查</span>
		<div class="inspector-actions">
			<span class:offline={connectionStatus === "disconnected"} class="connection-chip"><span class="status-dot" aria-hidden="true"></span>{connectionStatus === "connected" ? "已连接" : connectionStatus === "connecting" ? "连接中" : "已断开"}</span>
			<button class="icon-button theme-toggle" type="button" aria-label={themeActionLabel} title={themeActionLabel} on:click={onToggleTheme}>{#if theme === "light"}<Moon size={15} />{:else}<Sun size={15} />{/if}</button>
			{#if activeTab === "changes"}<button class="icon-button" type="button" aria-label="刷新 Git 状态" title="刷新 Git 状态" disabled={git.state === "loading" || state.phase === "running"} on:click={onRefreshGit}><RotateCw size={15} /></button>{/if}
			<button class="icon-button inspector-close" type="button" aria-label="关闭检查栏" title="关闭检查栏" on:click={onClose}><X size={17} /></button>
		</div>
	</div>
	<div class="inspector-tabs" role="tablist" aria-label="项目检查">
		<button id="inspector-tab-changes" class:active={activeTab === "changes"} type="button" role="tab" aria-selected={activeTab === "changes"} aria-controls="inspector-body" tabindex={activeTab === "changes" ? 0 : -1} on:click={() => onTabSelect("changes")} on:keydown={(event) => handleTabKeydown(event, "changes")}>
			<FileDiff size={16} strokeWidth={1.8} aria-hidden="true" /><span>Git</span>{#if git.state === "ready"}<small>{git.files.length}</small>{/if}
		</button>
		<button id="inspector-tab-terminal" class:active={activeTab === "terminal"} type="button" role="tab" aria-selected={activeTab === "terminal"} aria-controls="inspector-body" tabindex={activeTab === "terminal" ? 0 : -1} on:click={() => onTabSelect("terminal")} on:keydown={(event) => handleTabKeydown(event, "terminal")}>
			<Terminal size={16} strokeWidth={1.8} aria-hidden="true" /><span>命令记录</span><small>{terminalTools.length}</small>
		</button>
		<button id="inspector-tab-context" class:active={activeTab === "context"} type="button" role="tab" aria-selected={activeTab === "context"} aria-controls="inspector-body" tabindex={activeTab === "context" ? 0 : -1} on:click={() => onTabSelect("context")} on:keydown={(event) => handleTabKeydown(event, "context")}>
			<Info size={16} strokeWidth={1.8} aria-hidden="true" /><span>会话信息</span>
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
					<div class="git-overview"><span>+- 修改 {git.files.filter((file) => file.code.includes("M")).length}</span><span>N 未跟踪 {git.files.filter((file) => file.code === "??").length}</span></div>
					<div class="git-files">
						{#each git.files as file (`${file.code}:${file.path}`)}
							<button class:selected={selectedPath === file.path} class="git-file" type="button" aria-expanded={selectedPath === file.path} aria-controls="git-diff-panel" on:click={() => selectFile(file)}>
								<span class="git-mark" class:untracked={file.code === "??"} class:deleted={file.code.includes("D")} class:added={file.code.includes("A")} class:conflict={statusSymbol(file) === "!"} title={statusName(file)} aria-label={statusName(file)}>{statusSymbol(file)}</span>
								<span class="git-file-detail"><span class="git-path" title={file.path}>{file.path}</span>{#if file.previousPath}<span class="git-previous" title={file.previousPath}>原路径: {file.previousPath}</span>{/if}</span>
								<span class="git-file-meta">{#if file.added !== undefined || file.removed !== undefined}<span class="git-stat"><ins>+{file.added ?? 0}</ins><del>-{file.removed ?? 0}</del></span>{/if}{#if stageName(file)}<span class="git-stage" title={stageName(file)}>{stageName(file)}</span>{/if}</span>
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
			<div class="context-summary">
				<dl>{#each contextItems as item}<div><dt>{item[0]}</dt><dd title={item[1]}>{item[1]}</dd></div>{/each}</dl>
			</div>
		{/if}
	</div>
</aside>

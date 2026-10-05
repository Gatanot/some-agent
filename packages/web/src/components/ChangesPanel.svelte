<script lang="ts">
	import { FileDiff, GitBranch, RotateCw } from "@lucide/svelte";
	import { parseDiffLines } from "../diff.ts";
	import type { WebGitDiff, WebGitFile, WebSnapshot } from "../protocol.ts";
	import type { AppState, DiffLine } from "../types.ts";
	import SidePanel from "./SidePanel.svelte";

	export let snapshot: WebSnapshot | undefined;
	export let state: AppState;
	export let onRefreshGit: () => void;
	export let onGitDiff: (path: string) => Promise<WebGitDiff>;

	let selectedPath = "";
	let diffLines: DiffLine[] = [];
	let diffTruncated = false;
	let diffLoading = false;
	let diffError = "";

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
</script>

<SidePanel title="Changes" className="panel-changes">
	<button
		slot="actions"
		class="icon-button"
		type="button"
		aria-label="Refresh Git status"
		title="Refresh Git status"
		disabled={git.state === "loading" || state.phase === "running"}
		on:click={onRefreshGit}
	><RotateCw size={15} /></button>

	<div class="panel-scroll">
		{#if git.state === "loading"}
			<section class="panel-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>Reading Git status</strong></section>
		{:else if git.state === "unavailable"}
			<section class="panel-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>Not a Git repository</strong></section>
		{:else if git.state === "error"}
			<section class="panel-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>Could not read Git status</strong><span class="git-error">{git.error}</span></section>
		{:else}
			<div class="git-summary"><GitBranch size={15} /><span class="git-branch" title={git.root}>{git.branch}</span><span class="git-total">{git.files.length} files</span></div>
			{#if git.files.length === 0}
				<section class="panel-empty"><FileDiff size={24} strokeWidth={1.5} /><strong>No uncommitted changes</strong></section>
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
	</div>
</SidePanel>

<style>
.git-summary { display: flex; min-width: 0; align-items: center; gap: var(--space-2); padding: 13px 0; border-bottom: 1px solid var(--line); color: var(--accent); }
.git-branch { min-width: 0; flex: 1; overflow: hidden; color: var(--text); font-size: var(--text-xs); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.git-total { color: var(--text-subtle); font-size: var(--text-xs); white-space: nowrap; }
.git-overview { display: flex; gap: 15px; padding: 9px 0; border-bottom: 1px solid var(--line); color: var(--text-subtle); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); }
.git-file { display: grid; width: 100%; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); padding: 9px var(--space-1); border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; text-align: left; cursor: pointer; }
.git-file:hover { background: var(--surface-soft); }
.git-file.selected { background: var(--surface-active); }
.git-flag { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); font-weight: 700; }
.git-flag.untracked { color: var(--success); }
.git-flag.conflict { color: var(--danger); }
.git-file-detail { display: grid; min-width: 0; gap: 2px; }
.git-path, .git-previous { overflow: hidden; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.git-previous { color: var(--text-subtle); font-size: var(--text-xs); }
.git-file-meta { display: grid; justify-items: end; gap: 2px; }
.git-stat { display: flex; gap: 5px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); }
.git-stat ins { color: var(--success); text-decoration: none; }
.git-stat del { color: var(--danger); text-decoration: none; }
.git-diff { position: sticky; bottom: 0; margin: 0 -14px; border-top: 1px solid var(--line); background: var(--panel); }
.git-diff-head { display: flex; min-width: 0; align-items: baseline; gap: var(--space-2); padding: var(--space-2) 14px; border-bottom: 1px solid var(--line); color: var(--text-subtle); font-size: var(--text-xs); }
.git-diff-head code { min-width: 0; flex: 1; overflow: hidden; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.git-diff-view { max-height: 42vh; padding: 6px 0; overflow: auto; font-size: var(--text-xs); }
.git-diff-note { padding: 10px 14px; color: var(--text-subtle); font-size: var(--text-xs); }
.git-diff-note.error { color: var(--danger); }
</style>

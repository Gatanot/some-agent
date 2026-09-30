<script lang="ts">
	import { ChevronLeft, Folder, FolderOpen, Home, X } from "@lucide/svelte";
	import { workspaceFetch } from "../workspace.ts";

	interface BrowseEntry {
		name: string;
		path: string;
	}

	export let open: boolean;
	export let cwd: string;
	export let workspaces: string[];
	export let busy = false;
	export let onSelect: (path: string) => void;
	export let onClose: () => void;

	let browsePath = "";
	let parent: string | null = null;
	let home = "";
	let entries: BrowseEntry[] = [];
	let loading = false;
	let error = "";
	let pathInput = "";
	let requestId = 0;
	let wasOpen = false;

	function baseName(path: string): string {
		return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
	}

	async function browse(path: string): Promise<void> {
		const id = ++requestId;
		loading = true;
		error = "";
		try {
			const query = path ? `?path=${encodeURIComponent(path)}` : "";
			const response = await workspaceFetch(`/api/workspace/browse${query}`);
			const payload = (await response.json().catch(() => ({}))) as {
				path?: string;
				parent?: string | null;
				home?: string;
				entries?: BrowseEntry[];
				error?: string;
			};
			if (!response.ok || !payload.path) throw new Error(payload.error ?? `无法读取目录 (${response.status})`);
			if (id !== requestId) return;
			browsePath = payload.path;
			parent = payload.parent ?? null;
			home = payload.home ?? "";
			entries = payload.entries ?? [];
			pathInput = payload.path;
		} catch (cause) {
			if (id === requestId) error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (id === requestId) loading = false;
		}
	}

	function selectCurrent(): void {
		if (busy || loading || !browsePath || browsePath === cwd) return;
		onSelect(browsePath);
	}

	$: if (open && !wasOpen) {
		wasOpen = true;
		void browse(cwd);
	}
	$: if (!open && wasOpen) {
		wasOpen = false;
		entries = [];
		error = "";
	}
</script>

{#if open}
	<button class="workspace-backdrop" type="button" aria-label="关闭工作空间选择" on:click={onClose}></button>
	<div class="workspace-dialog" role="dialog" aria-modal="true" aria-label="选择工作空间">
		<header class="workspace-dialog-head">
			<h2>选择工作空间</h2>
			<button class="icon-button" type="button" aria-label="关闭工作空间选择" title="关闭" on:click={onClose}><X size={17} /></button>
		</header>
		<div class="workspace-dialog-body">
			{#if workspaces.length > 0}
				<section>
					<h3>最近使用</h3>
					<div class="workspace-recent-list">
						{#each workspaces as path (path)}
							<button class:current={path === cwd} class="workspace-recent-item" type="button" title={path} disabled={busy} on:click={() => onSelect(path)}>
								<Folder size={15} />
								<span class="workspace-recent-copy"><span class="workspace-recent-name">{baseName(path)}</span><span class="workspace-recent-path">{path}</span></span>
							</button>
						{/each}
					</div>
				</section>
			{/if}
			<section class="workspace-browse">
				<h3>浏览目录</h3>
				<div class="workspace-browse-bar">
					<button class="icon-button" type="button" aria-label="上级目录" title="上级目录" disabled={!parent || loading} on:click={() => parent && void browse(parent)}><ChevronLeft size={16} /></button>
					<button class="icon-button" type="button" aria-label="主目录" title="主目录" disabled={!home || loading || home === browsePath} on:click={() => void browse(home)}><Home size={15} /></button>
					<form class="workspace-path-form" on:submit|preventDefault={() => pathInput.trim() && void browse(pathInput.trim())}>
						<input bind:value={pathInput} aria-label="目录绝对路径" placeholder="输入绝对路径" spellcheck="false" />
						<button class="secondary-button" type="submit" disabled={loading || !pathInput.trim()}>转到</button>
					</form>
				</div>
				{#if error}<p class="workspace-browse-error" role="alert">{error}</p>{/if}
				<div class="workspace-browse-path" title={browsePath}>{browsePath || "…"}</div>
				<div class="workspace-browse-list">
					{#if loading}
						<div class="workspace-browse-note">正在读取…</div>
					{:else if error}
						<div class="workspace-browse-note">目录不可读</div>
					{:else if entries.length === 0}
						<div class="workspace-browse-note">没有子目录</div>
					{:else}
						{#each entries as entry (entry.path)}
							<button class="workspace-dir" type="button" disabled={loading} on:click={() => void browse(entry.path)}>
								<Folder size={14} /><span>{entry.name}</span>
							</button>
						{/each}
					{/if}
				</div>
			</section>
		</div>
		<footer class="workspace-dialog-foot">
			<div class="workspace-dialog-target" title={browsePath}>
				{#if browsePath === cwd}当前目录{:else}打开 <strong>{baseName(browsePath)}</strong>{/if}
			</div>
			<div class="workspace-dialog-actions">
				<button class="secondary-button" type="button" on:click={onClose}>取消</button>
				<button class="primary-button" type="button" disabled={busy || loading || !browsePath || browsePath === cwd} on:click={selectCurrent}><FolderOpen size={15} />选择此目录</button>
			</div>
		</footer>
	</div>
{/if}

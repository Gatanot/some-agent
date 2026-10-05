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
	let dialogElement: HTMLDialogElement;

	$: if (open && dialogElement && !dialogElement.open) dialogElement.showModal();
	$: if (!open && dialogElement?.open) dialogElement.close();

	function handleDialogClick(event: MouseEvent): void {
		if (event.target === dialogElement) onClose();
	}

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
		<dialog class="workspace-dialog" bind:this={dialogElement} aria-label="选择工作空间" on:click={handleDialogClick} on:close={onClose}>
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
</dialog>

<style>
.workspace-dialog { width: min(620px, calc(100vw - 40px)); max-height: min(82vh, 740px); padding: 0; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); color: var(--text); box-shadow: 0 24px 60px var(--shadow); }
.workspace-dialog[open] { display: flex; flex-direction: column; overflow: hidden; }
.workspace-dialog::backdrop { background: var(--backdrop); }
.workspace-dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.workspace-dialog-head h2 { margin: 0; font-size: var(--text-lg); font-weight: 680; }
.workspace-dialog .icon-button { border-color: transparent; }
.workspace-dialog-body { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 15px; padding: 15px 18px; overflow-y: auto; scrollbar-color: var(--line-strong) transparent; scrollbar-width: thin; }
.workspace-dialog-body h3 { margin: 0 0 var(--space-2); color: var(--text-subtle); font-size: var(--text-xs); font-weight: 680; letter-spacing: .04em; text-transform: uppercase; }
.workspace-recent-list { display: grid; gap: 5px; }
.workspace-recent-item { display: flex; min-width: 0; align-items: center; gap: 9px; padding: var(--space-2) 10px; border: 1px solid transparent; border-radius: 6px; background: var(--surface-raised); color: var(--text); text-align: left; }
.workspace-recent-item:hover:not(:disabled) { border-color: var(--line-strong); background: var(--surface-soft); }
.workspace-recent-item.current { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: color-mix(in srgb, var(--accent) 9%, var(--surface)); }
.workspace-recent-item :global(svg) { flex: 0 0 auto; color: var(--accent); }
.workspace-recent-copy { display: grid; min-width: 0; gap: 1px; }
.workspace-recent-name { overflow: hidden; font-size: var(--text-sm); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.workspace-recent-path { overflow: hidden; color: var(--text-subtle); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.workspace-browse { display: flex; min-height: 0; flex-direction: column; }
.workspace-browse-bar { display: flex; align-items: center; gap: 7px; }
.workspace-path-form { display: flex; min-width: 0; flex: 1; gap: 6px; }
.workspace-path-form input { min-width: 0; flex: 1; height: 32px; padding: var(--space-1) 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-raised); color: var(--text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); }
.workspace-browse-path { margin: 9px 0 7px; overflow: hidden; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.workspace-browse-list { display: grid; min-height: 150px; max-height: 260px; align-content: start; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-raised); scrollbar-color: var(--line-strong) transparent; scrollbar-width: thin; }
.workspace-dir { display: flex; min-width: 0; align-items: center; gap: var(--space-2); padding: 7px 10px; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; color: var(--text-muted); text-align: left; }
.workspace-dir:last-child { border-bottom: 0; }
.workspace-dir:hover:not(:disabled) { background: var(--surface-soft); color: var(--text); }
.workspace-dir :global(svg) { flex: 0 0 auto; color: var(--text-subtle); }
.workspace-dir span { overflow: hidden; font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.workspace-browse-note { padding: 26px 10px; color: var(--text-subtle); text-align: center; font-size: var(--text-xs); }
.workspace-browse-error { margin: 9px 0 0; color: var(--danger); font-size: var(--text-xs); }
.workspace-dialog-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) 18px; border-top: 1px solid var(--line); }
.workspace-dialog-target { min-width: 0; overflow: hidden; color: var(--text-subtle); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.workspace-dialog-target strong { color: var(--text); }
.workspace-dialog-actions { display: flex; flex: 0 0 auto; gap: var(--space-2); }
</style>

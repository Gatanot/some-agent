<script lang="ts">
	import { ChartColumn, FileDiff, FolderOpen, MessagesSquare, Moon, Settings as SettingsIcon, Sun } from "@lucide/svelte";
	import type { PanelId } from "../types.ts";

	export let activePanel: PanelId | null;
	export let onSelect: (panel: PanelId) => void;
	export let gitCount: number | undefined = undefined;
	export let running = false;
	export let workspacePath = "";
	export let theme: "light" | "dark";
	export let onToggleTheme: () => void;
	export let onChooseWorkspace: () => void;

	$: workspaceName = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
	$: workspaceLabel = workspaceName ? `Workspace: ${workspaceName}` : "Choose workspace";
	$: themeLabel = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
	$: gitBadge = gitCount === undefined || gitCount === 0 ? "" : gitCount > 99 ? "99+" : String(gitCount);
</script>

<nav class="activity-bar" aria-label="Panels and workspace">
	<div class="activity-group">
		<button
			class:active={activePanel === "sessions"}
			class="activity-button"
			type="button"
			data-panel="sessions"
			title="Sessions"
			aria-label="Sessions"
			aria-pressed={activePanel === "sessions"}
			on:click={() => onSelect("sessions")}
		>
			<MessagesSquare size={18} strokeWidth={1.8} aria-hidden="true" />
			{#if running}<span class="activity-dot" title="Prompt running" aria-hidden="true"></span>{/if}
		</button>
		<button
			class:active={activePanel === "changes"}
			class="activity-button"
			type="button"
			data-panel="changes"
			title={gitBadge ? `Changes (${gitCount} files)` : "Changes"}
			aria-label={gitBadge ? `Changes, ${gitCount} files` : "Changes"}
			aria-pressed={activePanel === "changes"}
			on:click={() => onSelect("changes")}
		>
			<FileDiff size={18} strokeWidth={1.8} aria-hidden="true" />
			{#if gitBadge}<span class="activity-badge" aria-hidden="true">{gitBadge}</span>{/if}
		</button>
		<button
			class:active={activePanel === "usage"}
			class="activity-button"
			type="button"
			data-panel="usage"
			title="Usage"
			aria-label="Usage"
			aria-pressed={activePanel === "usage"}
			on:click={() => onSelect("usage")}
		>
			<ChartColumn size={18} strokeWidth={1.8} aria-hidden="true" />
		</button>
		<button
			class:active={activePanel === "settings"}
			class="activity-button"
			type="button"
			data-panel="settings"
			title="Settings"
			aria-label="Settings"
			aria-pressed={activePanel === "settings"}
			on:click={() => onSelect("settings")}
		>
			<SettingsIcon size={18} strokeWidth={1.8} aria-hidden="true" />
		</button>
	</div>
	<div class="activity-group">
		<button class="activity-button" type="button" title={workspaceLabel} aria-label={workspaceLabel} aria-haspopup="dialog" on:click={onChooseWorkspace}>
			<FolderOpen size={18} strokeWidth={1.8} aria-hidden="true" />
		</button>
		<button class="activity-button" type="button" title={themeLabel} aria-label={themeLabel} on:click={onToggleTheme}>
			{#if theme === "light"}<Moon size={18} strokeWidth={1.8} aria-hidden="true" />{:else}<Sun size={18} strokeWidth={1.8} aria-hidden="true" />{/if}
		</button>
	</div>
</nav>

<style>
.activity-bar { grid-column: 1; display: flex; min-height: 0; flex-direction: column; align-items: center; justify-content: space-between; padding: var(--space-2) 0; border-right: 1px solid var(--line); background: var(--rail); }
.activity-group { display: flex; flex-direction: column; align-items: center; gap: var(--space-1); }
.activity-button { position: relative; display: inline-flex; width: 36px; height: 36px; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text-subtle); transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
.activity-button:hover { border-color: var(--line); background: var(--surface-soft); color: var(--text); }
.activity-button.active { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--accent); }
.activity-button::before { position: absolute; top: 50%; left: -6px; width: 2px; height: 0; border-radius: 0 2px 2px 0; background: var(--accent); content: ""; transform: translateY(-50%); transition: height .12s ease; }
.activity-button.active::before { height: 18px; }
.activity-dot { position: absolute; top: 6px; right: 6px; width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
.activity-badge { position: absolute; top: -3px; right: -3px; min-width: 15px; padding: 0 var(--space-1); border: 1px solid var(--rail); border-radius: 999px; background: var(--accent); color: var(--on-accent); font-size: var(--text-xs); font-weight: 700; line-height: 14px; text-align: center; }
@media (max-width: 600px) {
	.activity-bar { padding: 6px 0; }
	.activity-button { width: 34px; height: 34px; }
}
</style>

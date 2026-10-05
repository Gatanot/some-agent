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

<script lang="ts">
	import { ArrowUp, CircleStop } from "@lucide/svelte";
	import { applyMention, matchMention, type MentionMatch } from "../mentions.ts";
	import type { AppState, ModelOption } from "../types.ts";

	export let state: AppState;
	export let draft: string;
	export let onDraftChange: (value: string) => void;
	export let onSend: () => void;
	export let onStop: () => void;
	export let onModelChange: (value: string) => void;
	export let onThinkingChange: (level: string) => void;
	export let onFileSearch: (query: string) => Promise<string[]>;

	let textareaElement: HTMLTextAreaElement;
	let mention: MentionMatch | undefined;
	let suggestions: string[] = [];
	let suggestionIndex = 0;
	let mentionRequest = 0;
	let mentionTimer: ReturnType<typeof setTimeout> | undefined;

	function modelKey(model: ModelOption): string {
		return JSON.stringify([model.provider, model.id]);
	}

	$: selectedModel = state.models.find((model) => modelKey(model) === state.modelKey);
	$: modelSelectWidth = `${Math.max((selectedModel?.name.length ?? 12) + 5, 12)}ch`;
	$: usedTokens = Number.parseInt(state.usage.replaceAll(",", "").split(" ")[0] ?? "", 10);
	$: contextWindow = selectedModel?.contextWindow;
	$: contextPercent = contextWindow && Number.isFinite(usedTokens) ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : undefined;
	$: contextLabel = contextWindow ? `${contextPercent ?? 0}% · ${formatTokens(usedTokens)} / ${formatTokens(contextWindow)}` : state.usage;
	const contextRingRadius = 6;
	const contextRingCircumference = 2 * Math.PI * contextRingRadius;
	$: contextRingOffset = contextRingCircumference * (1 - Math.min(100, Math.max(0, contextPercent ?? 0)) / 100);
	$: mentionOpen = mention !== undefined && suggestions.length > 0;
	$: modelGroups = [...new Set(state.models.map((model) => model.provider))].map((provider) => ({
		provider,
		models: state.models.filter((model) => model.provider === provider),
	}));
	$: queued = state.queuedMessages ? [...state.queuedMessages.steering, ...state.queuedMessages.followUp] : [];
	$: if (draft === "") {
		suggestions = [];
		mention = undefined;
	}

	function formatTokens(value: number): string {
		if (!Number.isFinite(value)) return "Unknown";
		return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 10_000 ? `${Math.round(value / 1_000)}K` : value.toLocaleString("en-US");
	}

	function updateMention(value: string, caret: number): void {
		mention = matchMention(value, caret);
		if (mentionTimer) clearTimeout(mentionTimer);
		if (!mention) {
			suggestions = [];
			return;
		}
		const query = mention.query;
		mentionTimer = setTimeout(() => void loadSuggestions(query), 120);
	}

	async function loadSuggestions(query: string): Promise<void> {
		const requestId = ++mentionRequest;
		try {
			const files = await onFileSearch(query);
			if (requestId !== mentionRequest) return;
			suggestions = files;
			suggestionIndex = 0;
		} catch (cause) {
			if (requestId === mentionRequest) {
				suggestions = [];
				console.warn(`[orrery-web] file suggestions failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		}
	}

	function handleInput(event: Event): void {
		const target = event.currentTarget as HTMLTextAreaElement;
		onDraftChange(target.value);
		updateMention(target.value, target.selectionStart ?? target.value.length);
	}

	function acceptSuggestion(path: string): void {
		if (!mention) return;
		const current = mention;
		const next = applyMention(draft, current, path);
		onDraftChange(next.text);
		suggestions = [];
		mention = undefined;
		requestAnimationFrame(() => {
			if (!textareaElement) return;
			textareaElement.focus();
			textareaElement.setSelectionRange(next.caret, next.caret);
		});
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (suggestions.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				suggestionIndex = (suggestionIndex + 1) % suggestions.length;
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				suggestionIndex = (suggestionIndex - 1 + suggestions.length) % suggestions.length;
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				const path = suggestions[suggestionIndex];
				if (path !== undefined) {
					event.preventDefault();
					acceptSuggestion(path);
					return;
				}
			}
			if (event.key === "Escape") {
				event.preventDefault();
				suggestions = [];
				mention = undefined;
				return;
			}
		}
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
			event.preventDefault();
			onSend();
		}
	}

	function handleBlur(): void {
		// Let a suggestion click register before the dropdown closes.
		setTimeout(() => {
			suggestions = [];
			mention = undefined;
		}, 120);
	}
</script>

<footer class="composer">
	<div class="composer-inner">
		<div class="composer-box">
			{#if mentionOpen}
				<div class="mention-list" id="mention-list" role="listbox" aria-label="File suggestions">
					{#each suggestions as path, index (path)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<!-- svelte-ignore a11y_interactive_supports_focus -->
						<div class:active={index === suggestionIndex} class="mention-item" role="option" id={`mention-option-${index}`} aria-selected={index === suggestionIndex} on:mousedown={(event) => { event.preventDefault(); acceptSuggestion(path); }}>
							<span class="mention-path">{path}</span>
						</div>
					{/each}
				</div>
			{/if}
			{#if queued.length > 0}
				<div class="composer-queue" aria-label="Queued messages">
					{#each queued as item, index (index)}
						<span class="composer-queue-item" title={item}>{item}</span>
					{/each}
				</div>
			{/if}
			<textarea
				bind:this={textareaElement}
				aria-label="Task input"
				aria-autocomplete="list"
				aria-controls={mentionOpen ? "mention-list" : undefined}
				aria-activedescendant={mentionOpen ? `mention-option-${suggestionIndex}` : undefined}
				value={draft}
				placeholder=""
				on:input={handleInput}
				on:keydown={handleKeydown}
				on:blur={handleBlur}
			></textarea>
			<div class="composer-controls">
				<div class="composer-selects">
					<select aria-label="Model" title={selectedModel?.name ?? "Model"} style={`width: ${modelSelectWidth}`} value={state.modelKey} disabled={state.models.length === 0 || state.phase === "running" || state.phase === "compacting" || state.phase === "stopping"} on:change={(event) => onModelChange(event.currentTarget.value)}>
						{#if state.models.length === 0}<option value="">No models available</option>{/if}
						{#each modelGroups as group (group.provider)}
							<optgroup label={group.provider}>
								{#each group.models as model (`${model.provider}/${model.id}`)}
								<option value={modelKey(model)}>{model.name}</option>
							{/each}
							</optgroup>
						{/each}
					</select>
					<select aria-label="Thinking level" title="Thinking level" value={state.thinkingLevel} disabled={state.noModel || state.phase === "running" || state.phase === "compacting" || state.phase === "stopping" || state.thinkingLevels.length < 2} on:change={(event) => onThinkingChange(event.currentTarget.value)}>
						{#each state.thinkingLevels as level (level)}<option value={level}>{level}</option>{/each}
					</select>
				</div>
				<span class="context-usage" title={contextWindow ? `${formatTokens(usedTokens)} / ${formatTokens(contextWindow)} tokens` : state.usage}>
					{#if contextWindow !== undefined}
						<svg class="context-ring" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
							<circle class="context-ring-track" cx="8" cy="8" r={contextRingRadius} />
							<circle class="context-ring-fill" cx="8" cy="8" r={contextRingRadius} stroke-dasharray={contextRingCircumference} style={`stroke-dashoffset: ${contextRingOffset}`} />
						</svg>
					{/if}
					{contextLabel}
				</span>
				<div class="composer-actions">
					{#if state.phase === "running" && !draft.trim()}
						<button class="secondary-button composer-button send-button" type="button" aria-label="Stop" title="Stop" on:click={onStop}><CircleStop size={16} /></button>
					{:else}
						<button class="primary-button composer-button send-button" type="button" aria-label={state.phase === "running" || state.phase === "compacting" ? "Steer" : "Send"} title={state.phase === "running" || state.phase === "compacting" ? "Steer (Ctrl+Enter)" : "Send (Ctrl+Enter)"} disabled={state.unavailable || state.connection !== "connected" || state.noModel || !draft.trim()} on:click={onSend}><ArrowUp size={17} /></button>
					{/if}
				</div>
			</div>
		</div>
	</div>
</footer>

<style>
.composer { position: sticky; z-index: 2; bottom: 0; padding: 14px var(--space-5) 18px; background: var(--canvas); }
.composer-inner { width: min(820px, 100%); margin: 0 auto; }
.composer-controls, .composer-selects, .composer-actions { display: flex; min-width: 0; align-items: center; }
.composer-box { position: relative; padding: 13px 14px 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-lg); background: var(--surface-raised); box-shadow: 0 8px 24px var(--shadow); }
.mention-list { position: absolute; z-index: 4; right: 12px; bottom: calc(100% + 6px); left: 12px; max-height: 240px; padding: 3px; overflow-y: auto; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface-raised); box-shadow: 0 10px 30px var(--shadow); }
.mention-item { display: block; width: 100%; overflow: hidden; padding: 7px 10px; border-radius: 4px; background: transparent; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.mention-item.active, .mention-item:hover { background: var(--surface-soft); color: var(--text); }
.composer-queue { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
.composer-queue-item { max-width: 100%; overflow: hidden; padding: 2px var(--space-2); border: 1px solid var(--line); border-radius: 999px; background: var(--surface-soft); color: var(--text-muted); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.composer-box:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent), 0 8px 24px var(--shadow); }
textarea { display: block; width: 100%; min-height: 54px; max-height: 170px; field-sizing: content; resize: none; overflow-y: auto; border: 0; outline: 0; background: transparent; color: var(--text); line-height: 1.5; }
textarea:focus-visible { outline: none; }
textarea::placeholder { color: var(--text-subtle); }
.composer-controls { justify-content: space-between; gap: 9px; padding-top: 5px; }
.composer-selects { min-width: 0; gap: 6px; }
.context-usage { display: inline-flex; min-width: 0; align-items: center; gap: 6px; margin-left: auto; color: var(--text-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.context-ring { flex: 0 0 auto; transform: rotate(-90deg); }
.context-ring-track { fill: none; stroke: var(--line); stroke-width: 2; }
.context-ring-fill { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; transition: stroke-dashoffset .2s ease; }
.composer-button { min-width: 78px; height: 32px; }
.composer-button.send-button { min-width: 36px; width: 36px; padding: 0; }
@media (max-width: 820px) {
	.composer { padding-inline: 18px; }
}
@media (max-width: 600px) {
	.composer { padding: var(--space-2) var(--space-3) max(var(--space-3), env(safe-area-inset-bottom)); }
	.composer-box { padding: 10px; }
	.composer-controls { align-items: flex-end; }
	.composer-selects { flex-wrap: wrap; }
	.composer-button { min-width: 36px; }
}
</style>

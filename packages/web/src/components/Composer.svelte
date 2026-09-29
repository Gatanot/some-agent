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
			{#if mention && suggestions.length > 0}
				<div class="mention-list" role="listbox" aria-label="File suggestions">
					{#each suggestions as path, index (path)}
						<button class:active={index === suggestionIndex} class="mention-item" type="button" role="option" aria-selected={index === suggestionIndex} on:mousedown={(event) => { event.preventDefault(); acceptSuggestion(path); }}>
							<span class="mention-path">{path}</span>
						</button>
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
			<textarea bind:this={textareaElement} aria-label="Task input" value={draft} placeholder="" on:input={handleInput} on:keydown={handleKeydown} on:blur={handleBlur}></textarea>
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
				<span class="context-usage" title={contextWindow ? `${formatTokens(usedTokens)} / ${formatTokens(contextWindow)} tokens` : state.usage}>{contextLabel}</span>
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

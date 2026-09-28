<script lang="ts">
	import { ArrowUp, CircleStop } from "@lucide/svelte";
	import type { AppState, ModelOption } from "../types.ts";

	export let state: AppState;
	export let draft: string;
	export let onDraftChange: (value: string) => void;
	export let onSend: () => void;
	export let onStop: () => void;
	export let onModelChange: (value: string) => void;
	export let onThinkingChange: (level: string) => void;

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

	function formatTokens(value: number): string {
		if (!Number.isFinite(value)) return "未知";
		return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 10_000 ? `${Math.round(value / 1_000)}K` : value.toLocaleString("en-US");
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
			event.preventDefault();
			onSend();
		}
	}
</script>

<footer class="composer">
	<div class="composer-inner">
		<div class="composer-box">
			{#if queued.length > 0}
				<div class="composer-queue" aria-label="待发送消息">
					{#each queued as item, index (index)}
						<span class="composer-queue-item" title={item}>{item}</span>
					{/each}
				</div>
			{/if}
			<textarea aria-label="任务输入" value={draft} placeholder="" on:input={(event) => onDraftChange(event.currentTarget.value)} on:keydown={handleKeydown}></textarea>
			<div class="composer-controls">
				<div class="composer-selects">
					<select aria-label="模型" title={selectedModel?.name ?? "模型"} style={`width: ${modelSelectWidth}`} value={state.modelKey} disabled={state.models.length === 0 || state.phase === "running" || state.phase === "stopping"} on:change={(event) => onModelChange(event.currentTarget.value)}>
						{#if state.models.length === 0}<option value="">无可用模型</option>{/if}
						{#each modelGroups as group (group.provider)}
							<optgroup label={group.provider}>
								{#each group.models as model (`${model.provider}/${model.id}`)}
								<option value={modelKey(model)}>{model.name}</option>
							{/each}
							</optgroup>
						{/each}
					</select>
					<select aria-label="思考等级" title="思考等级" value={state.thinkingLevel} disabled={state.noModel || state.phase === "running" || state.phase === "stopping" || state.thinkingLevels.length < 2} on:change={(event) => onThinkingChange(event.currentTarget.value)}>
						{#each state.thinkingLevels as level (level)}<option value={level}>{level}</option>{/each}
					</select>
				</div>
				<span class="context-usage" title={contextWindow ? `${formatTokens(usedTokens)} / ${formatTokens(contextWindow)} tokens` : state.usage}>{contextLabel}</span>
				<div class="composer-actions">
					{#if state.phase === "running" && !draft.trim()}
						<button class="secondary-button composer-button" type="button" on:click={onStop}><CircleStop size={16} />停止</button>
					{:else}
						<button class="primary-button composer-button send-button" type="button" aria-label="发送" title="发送" disabled={state.unavailable || state.connection !== "connected" || state.noModel || !draft.trim()} on:click={onSend}><ArrowUp size={17} /></button>
					{/if}
				</div>
			</div>
		</div>
	</div>
</footer>

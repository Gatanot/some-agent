<script lang="ts">
	import { ChartColumn, RotateCw } from "@lucide/svelte";
	import type { WebContextPartKey, WebSnapshot, WebUsage } from "../protocol.ts";
	import SidePanel from "./SidePanel.svelte";
	import { workspaceFetch } from "../workspace.ts";

	export let snapshot: WebSnapshot | undefined;
	/** Incremented by the host when a turn settles, so the panel can refetch. */
	export let usageRefresh = 0;

	let usage: WebUsage | undefined;
	let usageLoading = false;
	let usageError = "";
	let maxDailyTokens = 1;
	let lastUsageRefresh = -1;

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
			const response = await workspaceFetch("/api/usage", { signal: controller.signal });
			const payload: unknown = await response.json();
			if (!response.ok) {
				const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `Failed to load usage (${response.status})`;
				throw new Error(message);
			}
			if (!isUsage(payload)) throw new Error("Unexpected usage response");
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
		return key === "Tools/summaries" ? "Tools & summaries" : key;
	}

	function contextLabel(key: WebContextPartKey): string {
		switch (key) {
			case "config":
				return "Config (AGENTS.md)";
			case "user":
				return "User input";
			case "tools":
				return "Tool results";
			case "assistant":
				return "Model output";
		}
	}

	function contextPercent(tokens: number): number {
		if (!contextWindow || contextWindow <= 0) return 0;
		return (tokens / contextWindow) * 100;
	}

	function contextUsageText(): string {
		if (!contextUsage) return "unknown";
		if (contextUsage.tokens === null) return "available after the next response";
		const window = `${formatTokens(contextUsage.tokens)} / ${formatTokens(contextUsage.contextWindow)}`;
		return contextUsage.percent === null ? window : `${window} (${contextUsage.percent.toFixed(1)}%)`;
	}

	$: session = snapshot?.sessionStats;
	$: contextParts = snapshot?.sessionStats?.context ?? [];
	$: contextTotal = contextParts.reduce((sum, part) => sum + part.tokens, 0);
	$: contextUsage = snapshot?.contextUsage;
	$: contextWindow = contextUsage?.contextWindow ?? snapshot?.models.find((model) => model.provider === snapshot?.model?.provider && model.id === snapshot?.model?.id)?.contextWindow;
	$: maxDailyTokens = Math.max(1, ...(usage?.daily.map((day) => day.tokens) ?? []));
	$: if (usageRefresh !== lastUsageRefresh) {
		lastUsageRefresh = usageRefresh;
		void loadUsage();
	}
</script>

<SidePanel title="Usage" className="panel-usage">
	<button slot="actions" class="icon-button" type="button" aria-label="Refresh usage" title="Refresh usage" disabled={usageLoading} on:click={loadUsage}><RotateCw size={15} /></button>

	<div class="panel-scroll">
		{#if session}
			<section class="session-block" aria-label="Current session usage">
				<div class="session-heading"><span>This session</span><span class="session-counts">{session.userMessages} prompts · {session.toolCalls} tool calls</span></div>
				{#if contextTotal > 0 && contextWindow && contextWindow > 0}
					<div class="context-bar" role="img" aria-label="Estimated context composition">
						{#each contextParts as part (part.key)}
							<span class={`context-segment ${part.key}`} style={`width: ${contextPercent(part.tokens)}%`} title={`${contextLabel(part.key)}: ${formatTokens(part.tokens)} tokens`}></span>
						{/each}
					</div>
					<div class="context-legend">
						{#each contextParts as part (part.key)}
							<div class="context-item"><span class={`context-dot ${part.key}`} aria-hidden="true"></span><span class="context-name">{contextLabel(part.key)}</span><span class="context-value">{Math.round(contextPercent(part.tokens))}% · {formatTokens(part.tokens)}</span></div>
						{/each}
					</div>
				{/if}
				<div class="session-foot"><span class="session-context-label">Context {contextUsageText()}</span><span class="session-token-total">{formatTokens(session.tokens)} tokens{#if session.cost > 0}<small>${session.cost.toFixed(2)}</small>{/if}</span></div>
			</section>
		{/if}
		{#if usageError}
			<section class="panel-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>Could not load usage</strong><span class="git-error">{usageError}</span></section>
		{:else if !usage}
			<section class="panel-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>Calculating usage</strong></section>
		{:else if usage.models.length === 0}
			<section class="panel-empty"><ChartColumn size={24} strokeWidth={1.5} /><strong>No usage in the last {usage.days} days</strong></section>
		{:else}
			<div class="usage-summary">
				<span class="usage-range">This project · {usage.days} days</span>
				<span class="usage-total">{formatTokens(usage.totalTokens)} tokens</span>
				{#if usage.totalCost > 0}<span class="usage-cost">${usage.totalCost.toFixed(2)}</span>{/if}
			</div>
			<div class="usage-days" aria-label={`Daily token usage for the last ${usage.days} days`}>
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
	</div>
</SidePanel>

<style>
.session-block { padding: var(--space-3) 0; border-bottom: 1px solid var(--line); }
.session-heading { display: flex; min-width: 0; align-items: baseline; gap: var(--space-2); }
.session-heading > span:first-child { color: var(--text); font-size: var(--text-xs); font-weight: 650; }
.session-counts { margin-left: auto; overflow: hidden; color: var(--text-subtle); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.context-bar { display: flex; height: 9px; gap: 1px; margin: 10px 0 9px; overflow: hidden; border-radius: 3px; background: var(--line); }
.context-segment { flex: 0 0 auto; }
.context-segment.config, .context-dot.config { background: var(--accent); }
.context-segment.user, .context-dot.user { background: var(--cyan); }
.context-segment.tools, .context-dot.tools { background: var(--success); }
.context-segment.assistant, .context-dot.assistant { background: var(--warning); }
.context-legend { display: grid; gap: 5px; }
.context-item { display: flex; min-width: 0; align-items: center; gap: 7px; font-size: var(--text-xs); }
.context-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 2px; }
.context-name { min-width: 0; flex: 1; overflow: hidden; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; }
.context-value { color: var(--text-subtle); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); white-space: nowrap; }
.session-foot { display: flex; align-items: baseline; gap: var(--space-2); padding-top: 11px; }
.session-context-label { color: var(--text-subtle); font-size: var(--text-xs); }
.session-token-total { margin-left: auto; color: var(--text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); font-weight: 700; white-space: nowrap; }
.session-token-total small { margin-left: 7px; color: var(--text-subtle); font-size: var(--text-xs); font-weight: 400; }
.usage-summary { display: flex; align-items: baseline; gap: var(--space-2); padding: var(--space-3) 0; border-bottom: 1px solid var(--line); }
.usage-range { color: var(--text-subtle); font-size: var(--text-xs); }
.usage-total { margin-left: auto; color: var(--text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-sm); font-weight: 700; }
.usage-cost { color: var(--text-subtle); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); }
.usage-days { display: flex; height: 96px; align-items: flex-end; gap: 3px; padding: 14px 0 6px; }
.usage-day { display: flex; height: 100%; flex: 1; align-items: flex-end; }
.usage-bar { width: 100%; border-radius: 2px 2px 0 0; background: var(--accent); }
.usage-bar.empty { background: var(--line); }
.usage-axis { display: flex; justify-content: space-between; padding-bottom: var(--space-3); border-bottom: 1px solid var(--line); color: var(--text-subtle); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); }
.usage-models { display: grid; }
.usage-model { display: flex; align-items: center; gap: var(--space-2); padding: 9px 0; border-bottom: 1px solid var(--line); }
.usage-model-key { min-width: 0; flex: 1; overflow: hidden; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.usage-model-value { color: var(--text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--text-xs); white-space: nowrap; }
.usage-model-value small { margin-left: 7px; color: var(--text-subtle); font-size: var(--text-xs); }
</style>

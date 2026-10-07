<script lang="ts">
	import { RotateCw } from "@lucide/svelte";
	import { afterUpdate, onMount } from "svelte";
	import CopyButton from "./CopyButton.svelte";
	import ToolCard from "./ToolCard.svelte";
	import type { AppState } from "../types.ts";

	export let state: AppState;
	export let onNoticeAction: (action: NonNullable<AppState["notice"]>["action"]) => void;
	export let onCopy: (value: string) => Promise<boolean>;
	export let onReconnect: () => void;

	let timelineElement: HTMLDivElement;
	let timelineHost: HTMLElement | undefined;
	let wasAtEnd = true;

	onMount(() => {
		const host = timelineElement.parentElement;
		if (!host) return;
		timelineHost = host;
		host.addEventListener("scroll", handleScroll, { passive: true });
		return () => host.removeEventListener("scroll", handleScroll);
	});

	function handleScroll(): void {
		if (!timelineHost) return;
		wasAtEnd = timelineHost.scrollHeight - timelineHost.scrollTop - timelineHost.clientHeight < 90;
	}

	function markdownCopy(node: HTMLElement): { destroy: () => void } {
		node.addEventListener("click", handleMarkdownClick);
		return { destroy: () => node.removeEventListener("click", handleMarkdownClick) };
	}

	async function copyMarkdownCode(button: HTMLButtonElement): Promise<void> {
		const code = button.closest(".markdown-code-block")?.querySelector("code")?.textContent;
		if (code === undefined) return;
		if (!(await onCopy(code.replace(/\n$/, "")))) return;
		button.classList.add("copied");
		button.textContent = "Copied";
		setTimeout(() => {
			button.classList.remove("copied");
			button.textContent = "Copy";
		}, 1500);
	}

	function handleMarkdownClick(event: MouseEvent): void {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const button = target.closest<HTMLButtonElement>("[data-markdown-copy]");
		if (button) void copyMarkdownCode(button);
	}

	$: if (state) {
		// State changes request a frame; afterUpdate keeps the follow-end behavior local to the timeline.
	}

	afterUpdate(() => {
		if (!timelineHost) return;
		if (wasAtEnd) timelineHost.scrollTop = timelineHost.scrollHeight;
		handleScroll();
	});
</script>

<div class="timeline-wrap" bind:this={timelineElement}>
	{#if state.phase === "compacting"}
		<div class="compaction-banner" role="status" aria-live="polite">
			<span class="compaction-spinner" aria-hidden="true"></span>
			<span><strong>Compacting conversation</strong> · summarizing older messages to make room for more context.</span>
		</div>
	{/if}
	{#if state.connection === "disconnected"}
		<div class="connection-banner">
			<span><strong>Connection lost</strong> · the agent state is preserved and resyncs after reconnecting.</span>
			<button class="secondary-button" type="button" on:click={onReconnect}><RotateCw size={14} /> Reconnect</button>
		</div>
	{/if}
	<div class="timeline" tabindex="-1" role="region" aria-label="Message timeline">
		<div class="timeline-inner">
			{#if state.notice}
				<section class={`notice ${state.notice.kind}`}>
					<div class="notice-title">{state.notice.title}</div>
					<div class="notice-body">{state.notice.body}</div>
					{#if state.notice.action}
						<div class="notice-actions">
							<button class={state.notice.kind === "error" ? "secondary-button" : "primary-button"} type="button" on:click={() => onNoticeAction(state.notice?.action)}>{state.notice.actionLabel}</button>
						</div>
					{/if}
				</section>
			{/if}

			{#if state.messages.length === 0 && state.unavailable}
				<section class="skeleton" role="status" aria-label="Connecting to the workspace">
					<div class="skeleton-line" style="width: 58%"></div>
					<div class="skeleton-line" style="width: 92%"></div>
					<div class="skeleton-line" style="width: 84%"></div>
					<div class="skeleton-line" style="width: 46%"></div>
				</section>
			{:else}
				{#each state.messages as message (message.id)}
					<article class={`message ${message.role}`} aria-label={message.role === "user" ? "User message" : message.role === "tools" ? "Tool calls" : "Agent reply"}>
						{#if message.role === "tools"}
							<div class="tool-group">
								{#each message.tools ?? [] as tool (tool.id)}
									<ToolCard {tool} {onCopy} />
								{/each}
							</div>
						{:else}
							<div class="message-content">
								{#each message.blocks ?? [] as block}
									{#if block.type === "text"}
										<div class="markdown-content" use:markdownCopy>{@html block.html}</div>
									{:else if block.type === "thinking"}
										<details class="thinking"><summary><span class="thinking-label">Thinking...</span></summary><div class="thinking-content markdown-content" use:markdownCopy>{@html block.html}</div></details>
									{:else if block.type === "code"}
										<div class="code-block"><div class="code-head"><span>{block.language}</span><CopyButton value={block.text} {onCopy} label="Copy code" /></div><pre>{block.text}</pre></div>
									{:else if block.type === "image"}
										<figure class="message-image"><img src={`data:${block.mimeType};base64,${block.data}`} alt="Conversation attachment" loading="lazy" /></figure>
									{/if}
								{/each}
								{#if message.error}
									<div class="error-block">
										<div>{message.error}</div>
										{#if message.errorAction}<div class="error-actions"><button class="error-retry" type="button" on:click={() => onNoticeAction(message.errorAction)}>Retry</button></div>{/if}
									</div>
								{/if}
							</div>
						{/if}
					</article>
				{/each}
			{/if}
		</div>
	</div>
</div>

<style>
.timeline-wrap { position: relative; min-height: 0; flex: 1 0 auto; }
.timeline { display: flex; flex-direction: column; min-height: 100%; padding: 28px var(--space-5) var(--space-4); }
.timeline-inner { width: min(820px, 100%); flex: 1; margin: 0 auto; }
.message { min-width: 0; margin-bottom: 28px; content-visibility: auto; contain-intrinsic-size: auto 120px; }
.message-content { min-width: 0; color: var(--text); font-size: var(--text-md); line-height: 1.7; }
.message.user .message-content { padding: 13px var(--space-4); border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--line)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--surface-raised) 94%, var(--accent) 6%); box-shadow: 0 2px 8px var(--shadow); }
.thinking { margin: 10px 0; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-raised); }
.thinking summary { display: flex; min-height: 36px; align-items: center; gap: var(--space-2); padding: 7px 11px; cursor: pointer; list-style: none; user-select: none; }
.thinking summary::-webkit-details-marker { display: none; }
.thinking summary::before { order: 5; margin-left: auto; color: var(--text-subtle); content: "+"; font-size: var(--text-lg); line-height: 1; }
.thinking[open] summary::before { content: "−"; }
.thinking-label { color: var(--warning); font-size: var(--text-sm); }
.thinking-content { padding: 0 var(--space-3) var(--space-3); color: var(--text-muted); font-size: var(--text-sm); }
.tool-group { min-width: 0; }
.message-image { margin: 10px 0; }
.message-image img { max-width: 100%; max-height: 420px; border: 1px solid var(--line); border-radius: 5px; background: var(--code-bg); object-fit: contain; }
.error-block { display: grid; gap: 9px; margin-top: var(--space-3); padding: 11px 13px; border: 1px solid var(--danger-line); border-radius: 4px; background: var(--danger-bg); color: var(--danger); }
.error-actions { display: flex; }
.error-retry { min-height: 28px; padding: 3px 10px; border: 1px solid var(--danger-line); background: transparent; color: var(--danger); font-size: var(--text-xs); cursor: pointer; }
.error-retry:hover { border-color: var(--danger); }
.notice { margin: var(--space-1) 0 23px; padding: 13px 15px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-raised); }
.notice.empty { background: var(--surface-raised); }
.notice.error { border-color: var(--danger-line); background: var(--danger-bg); }
.notice.warning { border-color: var(--warning-line); background: var(--warning-bg); }
.notice-title { font-weight: 650; }
.notice-body { margin-top: var(--space-1); color: var(--text-muted); overflow-wrap: anywhere; }
.notice-actions { display: flex; gap: var(--space-2); margin-top: 11px; }
.skeleton { display: grid; gap: 11px; padding: 6px 0 34px; }
.skeleton-line { height: 13px; border-radius: 4px; background: linear-gradient(90deg, var(--surface-soft) 25%, var(--surface-raised) 50%, var(--surface-soft) 75%); background-size: 200% 100%; animation: skeleton-sweep 1.5s ease-in-out infinite; }
@keyframes skeleton-sweep { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.compaction-banner { position: sticky; top: 10px; z-index: 2; display: flex; align-items: center; gap: 9px; margin: 0 auto var(--space-3); width: min(760px, 100%); padding: 10px 13px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 10px; background: color-mix(in srgb, var(--accent) 10%, var(--surface)); color: var(--text-subtle); font-size: var(--text-sm); }
.compaction-banner strong { color: var(--text); }
.compaction-spinner { width: 12px; height: 12px; flex: 0 0 12px; border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
.connection-banner { position: absolute; z-index: 3; top: 12px; right: 18px; left: 18px; display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 9px 7px 13px; border: 1px solid var(--warning-line); border-radius: 5px; background: var(--warning-bg); box-shadow: 0 8px 24px var(--shadow); color: var(--warning); font-size: var(--text-sm); }
.connection-banner strong { color: var(--text); }
@media (max-width: 820px) {
	.timeline { padding-inline: 18px; }
}
@media (max-width: 600px) {
	.timeline { padding: 18px var(--space-3) var(--space-5); }
	.connection-banner { right: 10px; left: 10px; }
}
</style>

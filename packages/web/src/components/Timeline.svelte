<script lang="ts">
	import { RotateCw } from "@lucide/svelte";
	import { afterUpdate } from "svelte";
	import CopyButton from "./CopyButton.svelte";
	import OutputBlock from "./OutputBlock.svelte";
	import ToolCard from "./ToolCard.svelte";
	import type { AppState } from "../types.ts";

	export let state: AppState;
	export let onNoticeAction: (action: NonNullable<AppState["notice"]>["action"]) => void;
	export let onCopy: (value: string) => Promise<boolean>;
	export let onReconnect: () => void;

	let timelineElement: HTMLDivElement;
	let wasAtEnd = true;

	function handleScroll(): void {
		if (!timelineElement) return;
		wasAtEnd = timelineElement.scrollHeight - timelineElement.scrollTop - timelineElement.clientHeight < 90;
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
		button.textContent = "已复制";
		setTimeout(() => {
			button.classList.remove("copied");
			button.textContent = "复制";
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
		if (!timelineElement) return;
		if (wasAtEnd) timelineElement.scrollTop = timelineElement.scrollHeight;
		handleScroll();
	});
</script>

<div class="timeline-wrap">
	{#if state.connection === "disconnected"}
		<div class="connection-banner">
			<span><strong>连接断开</strong> · agent 状态仍保留，重连后同步最新快照。</span>
			<button class="secondary-button" type="button" on:click={onReconnect}><RotateCw size={14} /> 重连</button>
		</div>
	{/if}
	<div class="timeline" bind:this={timelineElement} tabindex="-1" role="region" aria-label="消息时间线" on:scroll={handleScroll}>
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
				<section class="empty-state">
					<div class="empty-title">正在连接工作区</div>
					<div class="empty-body">连接建立后将显示当前会话。</div>
				</section>
			{:else}
				{#each state.messages as message (message.id)}
					<article class={`message ${message.role}`} aria-label={message.role === "user" ? "用户消息" : message.role === "tools" ? "工具调用" : "Agent 回复"}>
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
										<div class="code-block"><div class="code-head"><span>{block.language}</span><CopyButton value={block.text} {onCopy} label="复制代码" /></div><pre>{block.text}</pre></div>
									{:else if block.type === "largeOutput"}
										<OutputBlock text={block.text} {onCopy} />
									{:else if block.type === "image"}
										<figure class="message-image"><img src={`data:${block.mimeType};base64,${block.data}`} alt="对话图片" loading="lazy" /></figure>
									{/if}
								{/each}
								{#if message.error}
									<div class="error-block">
										<div>{message.error}</div>
										{#if message.errorAction}<div class="error-actions"><button class="error-retry" type="button" on:click={() => onNoticeAction(message.errorAction)}>重试任务</button></div>{/if}
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

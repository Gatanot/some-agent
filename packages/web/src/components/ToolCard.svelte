<script lang="ts" module>
	// Module-level so a tool card stays expanded across component recreation (for example when the
	// streaming message becomes a committed message).
	const openToolIds = new Set<string>();
</script>

<script lang="ts">
	import { onMount } from "svelte";
	import { ChevronDown } from "@lucide/svelte";
	import CopyButton from "./CopyButton.svelte";
	import type { DiffLine, Tool } from "../types.ts";

	export let tool: Tool;
	export let onCopy: (value: string) => Promise<boolean>;

	let now = Date.now();
	let open = openToolIds.has(tool.id);

	onMount(() => {
		const timer = setInterval(() => {
			if (tool.status === "running") now = Date.now();
		}, 500);
		return () => clearInterval(timer);
	});

	function toggle(): void {
		open = !open;
		if (open) openToolIds.add(tool.id);
		else openToolIds.delete(tool.id);
	}

	function displayName(): string {
		return tool.name === "bash" ? "Bash" : tool.name;
	}

	$: detailId = `tool-detail-${tool.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

	function elapsedSeconds(): number {
		if (tool.startedAt === undefined) return 0;
		const end = tool.status === "running" ? now : tool.finishedAt ?? now;
		return Math.max(0, Math.round((end - tool.startedAt) / 1000));
	}

	function timeText(): string {
		const elapsed = elapsedSeconds();
		return tool.timeoutSeconds === undefined ? `${elapsed}s` : `${elapsed}/${tool.timeoutSeconds}s`;
	}

	function statusLine(): string {
		if (tool.status === "running") return `time: ${timeText()}`;
		return tool.status === "error" ? `Failed. Time ${timeText()}` : `Done. Time ${timeText()}`;
	}

	function diffLines(value: Tool): DiffLine[] {
		return Array.isArray(value.output) ? value.output : [];
	}

	function outputText(value: Tool): string {
		return Array.isArray(value.output) ? value.output.map((line) => line.text).join("\n") : value.output;
	}
</script>

<div class:open class="tool-row">
	<button class="tool-toggle" type="button" aria-expanded={open} aria-controls={detailId} on:click={toggle}>
		<span class="tool-head">
			<span class:error={tool.status === "error"} class="tool-name">{displayName()}</span>
			<ChevronDown size={13} class={`tool-caret${open ? " open" : ""}`} aria-hidden="true" />
		</span>
		{#if tool.target}<span class="tool-target">{tool.target}</span>{/if}
	</button>
	{#if open}
		<div class="tool-detail" id={detailId}>
			{#if tool.outputType === "diff"}
				<pre class="tool-output">{#each diffLines(tool) as line}<span class={`diff-line ${line.kind}`}>{line.text}</span>{/each}</pre>
			{:else}
				<pre class="tool-output">{tool.output || (tool.status === "running" ? "等待结果…" : "（无输出）")}</pre>
			{/if}
		</div>
	{/if}
	<div class="tool-status-row">
		<span class={`tool-status ${tool.status}`}>{statusLine()}</span>
		{#if outputText(tool)}<CopyButton value={outputText(tool)} {onCopy} />{/if}
	</div>
</div>

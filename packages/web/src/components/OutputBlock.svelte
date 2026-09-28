<script lang="ts">
	import { previewOutput } from "../truncate.ts";
	import CopyButton from "./CopyButton.svelte";

	export let text: string;
	export let onCopy: (value: string) => Promise<boolean>;
	export let label = "输出";

	let expanded = false;
	$: preview = previewOutput(text);
	$: shown = expanded ? text : preview.text;
	$: note =
		preview.hiddenLines > 0
			? `已省略 ${preview.hiddenLines} 行（共 ${preview.totalLines} 行）`
			: `已省略 ${preview.hiddenChars} 字符`;
</script>

<div class="code-block output-block">
	<div class="code-head"><span>{label}</span><CopyButton value={text} {onCopy} label={`复制${label}`} /></div>
	<pre>{shown}</pre>
	{#if preview.truncated}
		<div class="output-note">
			<span>{note}</span>
			<button class="quiet-button output-toggle" type="button" aria-expanded={expanded} on:click={() => (expanded = !expanded)}>{expanded ? "收起" : "展开全部"}</button>
		</div>
	{/if}
</div>

<script lang="ts">
	import { previewOutput } from "../truncate.ts";
	import CopyButton from "./CopyButton.svelte";

	export let text: string;
	export let onCopy: (value: string) => Promise<boolean>;
	export let label = "Output";

	let expanded = false;
	$: preview = previewOutput(text);
	$: shown = expanded ? text : preview.text;
	$: note =
		preview.hiddenLines > 0
			? `${preview.hiddenLines} of ${preview.totalLines} lines hidden`
			: `${preview.hiddenChars} characters hidden`;
</script>

<div class="code-block output-block">
	<div class="code-head"><span>{label}</span><CopyButton value={text} {onCopy} label={`Copy ${label}`} /></div>
	<pre>{shown}</pre>
	{#if preview.truncated}
		<div class="output-note">
			<span>{note}</span>
			<button class="quiet-button output-toggle" type="button" aria-expanded={expanded} on:click={() => (expanded = !expanded)}>{expanded ? "Collapse" : "Expand all"}</button>
		</div>
	{/if}
</div>

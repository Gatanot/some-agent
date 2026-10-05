<script lang="ts">
	import type { DiffLine, Tool } from "../types.ts";

	export let tool: Tool;

	function diffLines(value: Tool): DiffLine[] {
		return Array.isArray(value.output) ? value.output : [];
	}
</script>

{#if tool.outputType === "diff"}
	<pre class="tool-output tool-diff">{#each diffLines(tool) as line}<span class={`diff-line ${line.kind}`}>{line.text}</span>{/each}</pre>
{:else if tool.output || !tool.images?.length}
	<pre class="tool-output">{tool.output || (tool.status === "running" ? "Waiting for result…" : "(no output)")}</pre>
{/if}

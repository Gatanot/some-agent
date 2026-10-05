<script lang="ts">
	import type { Tool } from "../types.ts";

	export let tool: Tool;

	$: lines = Array.isArray(tool.output) ? tool.output : [];
</script>

{#if lines.length > 0}
	<pre class="tool-output tool-diff">{#each lines as line}<span class={`diff-line ${line.kind}`}><span class="diff-marker">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>{line.text}</span>{/each}</pre>
{:else if typeof tool.output === "string" && tool.output}
	<pre class="tool-output">{tool.output}</pre>
{:else}
	<pre class="tool-output">{tool.status === "running" ? "Waiting for result…" : "(no output)"}</pre>
{/if}

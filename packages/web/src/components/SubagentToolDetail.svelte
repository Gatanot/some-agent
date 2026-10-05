<script lang="ts">
	import type { Tool } from "../types.ts";

	export let tool: Tool;

	$: prompt = typeof tool.args?.prompt === "string" ? tool.args.prompt : "";
	$: report = typeof tool.output === "string" ? tool.output : "";
</script>

<div class="tool-sections">
	{#if prompt}
		<section class="tool-section">
			<div class="tool-section-label">Prompt</div>
			<pre class="tool-section-body">{prompt}</pre>
		</section>
	{/if}
	<section class="tool-section">
		<div class="tool-section-label">Report</div>
		<pre class="tool-section-body">{report || (tool.status === "running" ? "Waiting for the subagent to finish…" : "(no report)")}</pre>
	</section>
</div>

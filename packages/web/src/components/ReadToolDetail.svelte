<script lang="ts">
	import { highlightCode, languageFromPath } from "../highlight.ts";
	import type { Tool } from "../types.ts";

	export let tool: Tool;

	$: path = typeof tool.args?.path === "string" ? tool.args.path : tool.target;
	$: output = typeof tool.output === "string" ? tool.output : "";
	$: language = languageFromPath(path);
	$: highlighted =
		language !== undefined && output.length > 0 && output.length <= 100_000 ? highlightCode(output, language) : "";
</script>

{#if highlighted}
	<pre class="tool-output tool-code">{@html highlighted}</pre>
{:else if output || !tool.images?.length}
	<pre class="tool-output">{output || (tool.status === "running" ? "Waiting for result…" : "(no output)")}</pre>
{/if}

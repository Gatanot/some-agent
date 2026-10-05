<script lang="ts">
	import { highlightCode, languageFromPath } from "../highlight.ts";
	import type { Tool } from "../types.ts";

	export let tool: Tool;

	$: path = typeof tool.args?.path === "string" ? tool.args.path : tool.target;
	$: content = typeof tool.args?.content === "string" ? tool.args.content : "";
	$: errorText = tool.status === "error" && typeof tool.output === "string" ? tool.output : "";
	$: highlighted =
		content.length > 0 && content.length <= 100_000 ? highlightCode(content, languageFromPath(path)) : "";
</script>

{#if errorText}
	<pre class="tool-output">{errorText}</pre>
{:else if content}
	{#if highlighted}
		<pre class="tool-output tool-code">{@html highlighted}</pre>
	{:else}
		<pre class="tool-output tool-code">{content}</pre>
	{/if}
{:else}
	<pre class="tool-output">{tool.status === "running" ? "Waiting for result…" : "(no content)"}</pre>
{/if}

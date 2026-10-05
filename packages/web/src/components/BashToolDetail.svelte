<script lang="ts">
	import type { Tool } from "../types.ts";

	export let tool: Tool;

	$: output = typeof tool.output === "string" ? tool.output : "";
</script>

<pre class="tool-output tool-terminal">{output || (tool.status === "running" ? "Waiting for result…" : "(no output)")}</pre>

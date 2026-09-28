<script lang="ts">
	import { PanelLeftOpen } from "@lucide/svelte";

	export let onOpen: () => void;
</script>

<aside class="activity-rail" aria-label="已收起的会话侧栏">
	<button class="rail-button" type="button" aria-label="展开会话侧栏" title="展开会话侧栏" on:click={onOpen}><PanelLeftOpen size={19} strokeWidth={1.8} /></button>
</aside>

<script lang="ts">
	import { PanelLeftOpen } from "@lucide/svelte";

	export let onOpen: () => void;
</script>

<aside class="activity-rail" aria-label="Collapsed session sidebar">
	<button class="rail-button" type="button" aria-label="Open session sidebar" title="Open session sidebar" on:click={onOpen}><PanelLeftOpen size={19} strokeWidth={1.8} /></button>
</aside>

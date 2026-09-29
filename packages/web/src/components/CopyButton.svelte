<script lang="ts">
	import { onDestroy } from "svelte";
	import { Check, Copy } from "@lucide/svelte";

	export let value: string;
	export let onCopy: (value: string) => Promise<boolean>;
	export let label = "Copy";

	let copied = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy(event: MouseEvent): Promise<void> {
		event.stopPropagation();
		if (!(await onCopy(value))) return;
		copied = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			copied = false;
		}, 1500);
	}

	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});
</script>

<button class:copied class="tool-copy" type="button" aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label} on:click={copy}>
	{#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
</button>

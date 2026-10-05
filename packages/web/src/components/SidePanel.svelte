<script lang="ts">
	export let title: string;
	export let ariaLabel = "";
	/** Extra class on the root, used by the host to size the panel. */
	export let className = "";
</script>

<aside class={`side-panel ${className}`} aria-label={ariaLabel || title}>
	<header class="side-panel-head">
		<h2 class="side-panel-title">{title}</h2>
		<div class="side-panel-actions"><slot name="actions" /></div>
	</header>
	<div class="side-panel-body"><slot /></div>
</aside>

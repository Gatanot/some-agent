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

<style>
.side-panel { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; flex-direction: column; border-left: 1px solid var(--line); background: var(--panel); }
.side-panel-head { display: flex; min-height: 56px; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 0 var(--space-2) 0 14px; border-bottom: 1px solid var(--line); }
.side-panel-title { overflow: hidden; margin: 0; color: var(--text); font-size: var(--text-md); font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.side-panel-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; }
.side-panel-actions :global(.icon-button) { width: 28px; height: 28px; min-height: 28px; border-color: transparent; }
.side-panel-body { display: flex; min-height: 0; flex: 1; flex-direction: column; }
@media (max-width: 600px) {
	.side-panel-head { min-height: 52px; }
}
</style>

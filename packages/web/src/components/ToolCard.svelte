<script lang="ts" module>
	// Module-level so a tool card stays expanded across component recreation (for example when the
	// streaming message becomes a committed message).
	const openToolIds = new Set<string>();

	const SUBAGENT_NAMES = [
		"Rigel", "Altair", "Deneb", "Canopus", "Procyon", "Capella", "Pollux", "Mimosa",
		"Hadar", "Albireo", "Fomalhaut", "Nunki", "Sheliak", "Spica", "Antares", "Regulus",
		"Achernar", "Arcturus", "Mizar", "Alkaid", "Alnilam", "Bellatrix", "Izar", "Rasalhague",
		"Kochab", "Thuban", "Etamin", "Schedar", "Nashira", "Algieba",
		"Sirius", "Vega", "Polaris", "Betelgeuse", "Aldebaran", "Castor", "Acrux", "Gacrux",
		"Shaula", "Alnitak", "Saiph", "Alcor", "Algol", "Denebola", "Dubhe", "Alioth",
		"Alpheratz", "Mirfak", "Elnath", "Alphard", "Proxima",
	];

	function subagentName(id: string): string {
		let h = 0;
		for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
		return SUBAGENT_NAMES[h % SUBAGENT_NAMES.length];
	}
</script>

<script lang="ts">
	import { onMount } from "svelte";
	import { ChevronDown, Images } from "@lucide/svelte";
	import BashToolDetail from "./BashToolDetail.svelte";
	import CopyButton from "./CopyButton.svelte";
	import EditToolDetail from "./EditToolDetail.svelte";
	import GenericToolDetail from "./GenericToolDetail.svelte";
	import ReadToolDetail from "./ReadToolDetail.svelte";
	import SubagentToolDetail from "./SubagentToolDetail.svelte";
	import WriteToolDetail from "./WriteToolDetail.svelte";
	import type { Tool } from "../types.ts";

	export let tool: Tool;
	export let onCopy: (value: string) => Promise<boolean>;

	let now = Date.now();
	let open = openToolIds.has(tool.id) || (tool.name === "subagent" && tool.status === "running");

	onMount(() => {
		const timer = setInterval(() => {
			if (tool.status === "running") now = Date.now();
		}, 500);
		return () => clearInterval(timer);
	});

	function toggle(): void {
		open = !open;
		if (open) openToolIds.add(tool.id);
		else openToolIds.delete(tool.id);
	}

	function displayName(): string {
		return tool.name === "bash" ? "Bash" : tool.name;
	}

	$: detailId = `tool-detail-${tool.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

	function elapsedSeconds(): number {
		if (tool.startedAt === undefined) return 0;
		const end = tool.status === "running" ? now : tool.finishedAt ?? now;
		return Math.max(0, Math.round((end - tool.startedAt) / 1000));
	}

	function timeText(): string {
		const elapsed = elapsedSeconds();
		return tool.timeoutSeconds === undefined ? `${elapsed}s` : `${elapsed}/${tool.timeoutSeconds}s`;
	}

	function statusLine(): string {
		if (tool.status === "running") return `time: ${timeText()}`;
		return tool.status === "error" ? `Failed. Time ${timeText()}` : `Done. Time ${timeText()}`;
	}

	function outputText(value: Tool): string {
		if (!Array.isArray(value.output)) return value.output;
		return value.output
			.map((line) => (line.kind === "add" ? `+${line.text}` : line.kind === "remove" ? `-${line.text}` : line.text))
			.join("\n");
	}

	/** Compact per-tool summary shown next to the name so a collapsed card still says what changed. */
	function headerMeta(): string {
		if (tool.name === "edit" && Array.isArray(tool.output)) {
			let added = 0;
			let removed = 0;
			for (const line of tool.output) {
				if (line.kind === "add") added++;
				else if (line.kind === "remove") removed++;
			}
			return added === 0 && removed === 0 ? "" : `+${added} −${removed}`;
		}
		if (tool.name === "write") {
			const content = tool.args?.content;
			if (typeof content !== "string") return "";
			const lines = content === "" ? 0 : content.split("\n").length;
			return `${lines} line${lines === 1 ? "" : "s"}`;
		}
		if (tool.name === "read") {
			const offset = typeof tool.args?.offset === "number" ? tool.args.offset : undefined;
			const limit = typeof tool.args?.limit === "number" ? tool.args.limit : undefined;
			if (offset === undefined && limit === undefined) return "";
			const start = offset ?? 1;
			return limit === undefined ? `from line ${start}` : `lines ${start}–${start + limit - 1}`;
		}
		return "";
	}
</script>

<div class:open class="tool-row">
	<button class="tool-toggle" type="button" aria-expanded={open} aria-controls={detailId} on:click={toggle}>
		<span class="tool-head">
			<span class:error={tool.status === "error"} class="tool-name">{displayName()}</span>
			{#if tool.name === "subagent"}<span class="tool-subagent-name">{subagentName(tool.id)}</span>{/if}
			{#if headerMeta()}<span class="tool-meta">{headerMeta()}</span>{/if}
			<ChevronDown size={13} class={`tool-caret${open ? " open" : ""}`} aria-hidden="true" />
		</span>
		{#if tool.target}<span class={`tool-target${tool.name === "subagent" ? " tool-target-prompt" : ""}`}>{tool.target}</span>{/if}
		{#if tool.images?.length}<span class="tool-image-count" title={`${tool.images.length} image${tool.images.length === 1 ? "" : "s"}`}><Images size={12} aria-hidden="true" />{tool.images.length}</span>{/if}
	</button>
	{#if open}
		<div class="tool-detail" id={detailId}>
			{#if tool.images?.length}
				<div class="tool-images">
					{#each tool.images as image, index (index)}
						<figure class="tool-image">
							<img src={`data:${image.mimeType};base64,${image.data}`} alt={`Tool result attachment ${index + 1}`} loading="lazy" />
							<figcaption>{image.mimeType}</figcaption>
						</figure>
					{/each}
				</div>
			{/if}
			{#if tool.name === "edit"}
				<EditToolDetail {tool} />
			{:else if tool.name === "write"}
				<WriteToolDetail {tool} />
			{:else if tool.name === "subagent"}
				<SubagentToolDetail {tool} />
			{:else if tool.name === "read"}
				<ReadToolDetail {tool} />
			{:else if tool.name === "bash" || tool.name === "powershell"}
				<BashToolDetail {tool} />
			{:else}
				<GenericToolDetail {tool} />
			{/if}
		</div>
	{/if}
	<div class="tool-status-row">
		<span class={`tool-status ${tool.status}`}>{statusLine()}</span>
		{#if outputText(tool)}<CopyButton value={outputText(tool)} {onCopy} />{/if}
	</div>
</div>

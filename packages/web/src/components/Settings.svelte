<script lang="ts">
	import { X } from "@lucide/svelte";
	import type { WebSettings } from "../protocol.ts";
	import type { ModelOption } from "../types.ts";

	export let open: boolean;
	export let models: ModelOption[] = [];
	export let onClose: () => void;

	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	let settings: WebSettings | undefined;
	let loading = false;
	let error = "";
	let saving = false;
	let requestId = 0;

	let newProvider = "";
	let newModelId = "";
	let newLevel = "medium";

	function modelKey(model: ModelOption): string {
		return `${model.provider}/${model.id}`;
	}

	function splitKey(key: string): { provider: string; id: string } {
		const slash = key.indexOf("/");
		return slash < 0 ? { provider: key, id: "" } : { provider: key.slice(0, slash), id: key.slice(slash + 1) };
	}

	function isSettings(value: unknown): value is WebSettings {
		if (typeof value !== "object" || value === null) return false;
		const record = value as Record<string, unknown>;
		if (!Array.isArray(record.modelThinkingLevels)) return false;
		const compaction = record.compaction;
		if (typeof compaction !== "object" || compaction === null) return false;
		const retry = record.retry;
		return typeof retry === "object" && retry !== null;
	}

	async function requestSettings(path: string, init?: RequestInit): Promise<WebSettings> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		try {
			const response = await fetch(path, { ...init, signal: controller.signal });
			const payload: unknown = await response.json().catch(() => ({}));
			if (!response.ok) {
				const message =
					typeof payload === "object" && payload !== null && "error" in payload
						? String((payload as { error: unknown }).error)
						: `Settings request failed (${response.status})`;
				throw new Error(message);
			}
			if (!isSettings(payload)) throw new Error("Unexpected settings response");
			return payload;
		} finally {
			clearTimeout(timeout);
		}
	}

	async function loadSettings(): Promise<void> {
		const id = ++requestId;
		loading = true;
		error = "";
		try {
			const next = await requestSettings("/api/settings");
			if (id === requestId) settings = next;
		} catch (cause) {
			if (id === requestId) error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (id === requestId) loading = false;
		}
	}

	async function patch(patchValue: Record<string, unknown>): Promise<void> {
		saving = true;
		error = "";
		try {
			settings = await requestSettings("/api/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patchValue),
			});
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			saving = false;
		}
	}

	function saveDefaultModel(value: string): void {
		if (!value) return;
		void patch({ defaultModel: splitKey(value) });
	}

	function saveDefaultThinking(value: string): void {
		void patch({ defaultThinkingLevel: value });
	}

	function saveNumber(patchKey: string, raw: string): void {
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isInteger(parsed) || parsed < 0) return;
		void patch({ [patchKey]: parsed });
	}

	function updateOverride(provider: string, id: string, level: string): void {
		if (!settings) return;
		const next = settings.modelThinkingLevels.map((entry) =>
			entry.provider === provider && entry.id === id ? { ...entry, level } : entry,
		);
		void patch({ modelThinkingLevels: next });
	}

	function removeOverride(provider: string, id: string): void {
		if (!settings) return;
		void patch({
			modelThinkingLevels: settings.modelThinkingLevels.filter((entry) => !(entry.provider === provider && entry.id === id)),
		});
	}

	function addOverride(): void {
		if (!settings || !newProvider || !newModelId) return;
		const exists = settings.modelThinkingLevels.some((entry) => entry.provider === newProvider && entry.id === newModelId);
		const next = exists
			? settings.modelThinkingLevels.map((entry) =>
					entry.provider === newProvider && entry.id === newModelId ? { ...entry, level: newLevel } : entry,
				)
			: [...settings.modelThinkingLevels, { provider: newProvider, id: newModelId, level: newLevel }];
		void patch({ modelThinkingLevels: next });
	}

	$: defaultModelValue = settings?.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : "";
	$: availableModels = [...new Set(models.map((model) => model.provider))].map((provider) => ({
		provider,
		models: models.filter((model) => model.provider === provider),
	}));
	let wasOpen = false;
	$: if (open && !wasOpen) {
		wasOpen = true;
		void loadSettings();
	}
	$: if (!open && wasOpen) {
		wasOpen = false;
		settings = undefined;
		error = "";
	}
</script>

{#if open}
	<button class="settings-backdrop" type="button" aria-label="Close settings" on:click={onClose}></button>
	<div class="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
		<header class="settings-head">
			<h2>Settings</h2>
			<button class="icon-button" type="button" aria-label="Close settings" title="Close settings" on:click={onClose}><X size={17} /></button>
		</header>
		<div class="settings-body">
			{#if error}<div class="settings-error">{error}</div>{/if}
			{#if loading && !settings}
				<div class="settings-placeholder">Loading settings…</div>
			{:else if !settings}
				<div class="settings-placeholder">Settings are unavailable.</div>
			{:else}
				<section class="settings-section">
					<h3>Model</h3>
					<p class="settings-note">These defaults apply to new sessions; the composer changes the active session.</p>
					<label class="settings-field">
						<span>Default model</span>
						<select disabled={saving} value={defaultModelValue} on:change={(event) => saveDefaultModel(event.currentTarget.value)}>
							<option value="">Keep current default</option>
							{#each availableModels as group (group.provider)}
								<optgroup label={group.provider}>
									{#each group.models as model (`${model.provider}/${model.id}`)}
										<option value={modelKey(model)}>{model.name}</option>
									{/each}
								</optgroup>
							{/each}
						</select>
					</label>
					<label class="settings-field">
						<span>Default thinking level</span>
						<select disabled={saving} value={settings.defaultThinkingLevel ?? ""} on:change={(event) => saveDefaultThinking(event.currentTarget.value)}>
							<option value="">Not set</option>
							{#each thinkingLevels as level (level)}
								<option value={level}>{level}</option>
							{/each}
						</select>
					</label>
				</section>

				<section class="settings-section">
					<h3>Thinking level per model</h3>
					{#if settings.modelThinkingLevels.length === 0}
						<p class="settings-note">No per-model overrides. The default level applies.</p>
					{:else}
						{#each settings.modelThinkingLevels as entry (`${entry.provider}/${entry.id}`)}
							<div class="settings-row">
								<span class="settings-model" title={`${entry.provider}/${entry.id}`}>{entry.provider}/{entry.id}</span>
								<select disabled={saving} value={entry.level} on:change={(event) => updateOverride(entry.provider, entry.id, event.currentTarget.value)}>
									{#each thinkingLevels as level (level)}
										<option value={level}>{level}</option>
									{/each}
								</select>
								<button class="quiet-button" type="button" disabled={saving} on:click={() => removeOverride(entry.provider, entry.id)}>Remove</button>
							</div>
						{/each}
					{/if}
					<div class="settings-row">
						<select bind:value={newProvider} aria-label="Model provider">
							<option value="">Provider</option>
							{#each availableModels as group (group.provider)}
								<option value={group.provider}>{group.provider}</option>
							{/each}
						</select>
						<select bind:value={newModelId} aria-label="Model">
							<option value="">Model</option>
							{#each models.filter((model) => model.provider === newProvider) as model (`${model.provider}/${model.id}`)}
								<option value={model.id}>{model.name}</option>
							{/each}
						</select>
						<select bind:value={newLevel} aria-label="Thinking level">
							{#each thinkingLevels as level (level)}
								<option value={level}>{level}</option>
							{/each}
						</select>
						<button class="secondary-button" type="button" disabled={saving || !newProvider || !newModelId} on:click={addOverride}>Add</button>
					</div>
				</section>

				<section class="settings-section">
					<h3>Compaction</h3>
					<label class="settings-check">
						<input type="checkbox" checked={settings.compaction.enabled} disabled={saving} on:change={(event) => void patch({ compactionEnabled: event.currentTarget.checked })} />
						<span>Automatically compact long sessions</span>
					</label>
					<label class="settings-field">
						<span>Reserve tokens</span>
						<input type="number" min="0" step="1024" value={settings.compaction.reserveTokens} disabled={saving} on:change={(event) => saveNumber("compactionReserveTokens", event.currentTarget.value)} />
					</label>
					<label class="settings-field">
						<span>Keep recent tokens</span>
						<input type="number" min="0" step="1024" value={settings.compaction.keepRecentTokens} disabled={saving} on:change={(event) => saveNumber("compactionKeepRecentTokens", event.currentTarget.value)} />
					</label>
				</section>

				<section class="settings-section">
					<h3>Queueing</h3>
					<label class="settings-field">
						<span>Steering messages</span>
						<select disabled={saving} value={settings.steeringMode} on:change={(event) => void patch({ steeringMode: event.currentTarget.value })}>
							<option value="one-at-a-time">one at a time</option>
							<option value="all">all</option>
						</select>
					</label>
					<label class="settings-field">
						<span>Follow-up messages</span>
						<select disabled={saving} value={settings.followUpMode} on:change={(event) => void patch({ followUpMode: event.currentTarget.value })}>
							<option value="one-at-a-time">one at a time</option>
							<option value="all">all</option>
						</select>
					</label>
					<label class="settings-check">
						<input type="checkbox" checked={settings.retry.enabled} disabled={saving} on:change={(event) => void patch({ retryEnabled: event.currentTarget.checked })} />
						<span>Retry failed provider requests</span>
					</label>
				</section>
			{/if}
		</div>
	</div>
{/if}

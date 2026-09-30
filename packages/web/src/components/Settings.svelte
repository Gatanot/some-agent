<script lang="ts">
	import { RotateCw, X } from "@lucide/svelte";
	import type { WebSettings } from "../protocol.ts";
	import type { ModelOption } from "../types.ts";
	import { workspaceFetch } from "../workspace.ts";

	export let open: boolean;
	export let onClose: () => void;

	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	let settings: WebSettings | undefined;
	let loading = false;
	let error = "";
	let saving = false;
	let requestId = 0;

	let catalog: ModelOption[] = [];
	let modelQuery = "";
	let refreshing = false;
	let refreshMessage = "";
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
			const response = await workspaceFetch(path, { ...init, signal: controller.signal });
			const payload: unknown = await response.json().catch(() => ({}));
			if (!response.ok) {
				const message =
					typeof payload === "object" && payload !== null && "error" in payload
						? String((payload as { error: unknown }).error)
						: `设置请求失败 (${response.status})`;
				throw new Error(message);
			}
			if (!isSettings(payload)) throw new Error("设置响应格式不正确");
			return payload;
		} finally {
			clearTimeout(timeout);
		}
	}

	async function loadCatalog(): Promise<void> {
		const response = await workspaceFetch("/api/models");
		const payload = (await response.json()) as { models?: ModelOption[]; error?: string };
		if (!response.ok) throw new Error(payload.error ?? "无法读取模型目录");
		catalog = payload.models ?? [];
	}

	async function loadSettings(): Promise<void> {
		const id = ++requestId;
		loading = true;
		error = "";
		try {
			const [next] = await Promise.all([requestSettings("/api/settings"), loadCatalog()]);
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

	async function refreshModels(): Promise<void> {
		refreshing = true;
		error = "";
		refreshMessage = "";
		try {
			const response = await workspaceFetch("/api/models/refresh", { method: "POST" });
			const payload = (await response.json()) as { errors?: string[]; error?: string };
			if (!response.ok) throw new Error(payload.error ?? "刷新失败");
			await loadCatalog();
			refreshMessage = payload.errors?.length ? payload.errors.join("; ") : "模型目录已刷新";
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			refreshing = false;
		}
	}

	function toggleModel(model: ModelOption, checked: boolean): void {
		if (!settings) return;
		const key = modelKey(model);
		const current = settings.enabledModels ?? catalog.map(modelKey);
		const next = checked ? [...new Set([...current, key])] : current.filter((entry) => entry !== key);
		void patch({ enabledModels: next });
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
	$: availableModels = [...new Set(catalog.map((model) => model.provider))].map((provider) => ({
		provider,
		models: catalog.filter((model) => model.provider === provider),
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
	<button class="settings-backdrop" type="button" aria-label="关闭设置" on:click={onClose}></button>
	<div class="settings-panel" role="dialog" aria-modal="true" aria-label="设置">
		<header class="settings-head">
			<h2>设置</h2>
			<button class="icon-button" type="button" aria-label="关闭设置" title="关闭设置" on:click={onClose}><X size={17} /></button>
		</header>
		<div class="settings-body">
			{#if error}<div class="settings-error">{error}</div>{/if}
			{#if loading && !settings}
				<div class="settings-placeholder">正在加载设置…</div>
			{:else if !settings}
				<div class="settings-placeholder">设置暂不可用。</div>
			{:else}
				<section class="settings-section">
					<h3>模型</h3>
					<p class="settings-note">默认值应用于新会话；当前会话的模型可在输入栏切换。</p>
					<label class="settings-field">
						<span>默认模型</span>
						<select disabled={saving} value={defaultModelValue} on:change={(event) => saveDefaultModel(event.currentTarget.value)}>
							<option value="">保持当前默认值</option>
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
						<span>默认思考级别</span>
						<select disabled={saving} value={settings.defaultThinkingLevel ?? ""} on:change={(event) => saveDefaultThinking(event.currentTarget.value)}>
							<option value="">未设置</option>
							{#each thinkingLevels as level (level)}
								<option value={level}>{level}</option>
							{/each}
						</select>
					</label>
				</section>

				<section class="settings-section">
					<div class="settings-section-head"><h3>常用模型</h3><button class="icon-button" type="button" aria-label="从提供商刷新模型目录" title="从提供商刷新模型目录" disabled={refreshing || saving} on:click={refreshModels}><RotateCw size={16} /></button></div>
					<p class="settings-note">仅控制模型轮换范围，不会撤销认证或禁用模型调用。未设置时全部可用模型默认选中。</p>
					{#if refreshMessage}<p class="settings-note" role="status">{refreshMessage}</p>{/if}
					<input class="model-search" type="search" bind:value={modelQuery} aria-label="搜索模型" placeholder="搜索提供商或模型" />
					<div class="model-list">
						{#each availableModels as group (group.provider)}
							{#if group.models.some((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(modelQuery.toLowerCase()))}
								<h4>{group.provider}</h4>
								{#each group.models.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(modelQuery.toLowerCase())) as model (`${model.provider}/${model.id}`)}
									<label class="settings-check"><input type="checkbox" checked={settings.enabledModels === undefined ? true : settings.enabledModels.includes(modelKey(model))} disabled={saving} on:change={(event) => toggleModel(model, event.currentTarget.checked)} /><span>{model.name} <small>{model.id}</small></span></label>
								{/each}
							{/if}
						{/each}
					</div>
				</section>

				<section class="settings-section">
					<h3>逐模型思考级别</h3>
					{#if settings.modelThinkingLevels.length === 0}
						<p class="settings-note">没有单独设置，使用默认级别。</p>
					{:else}
						{#each settings.modelThinkingLevels as entry (`${entry.provider}/${entry.id}`)}
							<div class="settings-row">
								<span class="settings-model" title={`${entry.provider}/${entry.id}`}>{entry.provider}/{entry.id}</span>
								<select disabled={saving} value={entry.level} on:change={(event) => updateOverride(entry.provider, entry.id, event.currentTarget.value)}>
									{#each thinkingLevels as level (level)}
										<option value={level}>{level}</option>
									{/each}
								</select>
								<button class="quiet-button" type="button" disabled={saving} on:click={() => removeOverride(entry.provider, entry.id)}>移除</button>
							</div>
						{/each}
					{/if}
					<div class="settings-row">
						<select bind:value={newProvider} aria-label="Model provider">
							<option value="">提供商</option>
							{#each availableModels as group (group.provider)}
								<option value={group.provider}>{group.provider}</option>
							{/each}
						</select>
						<select bind:value={newModelId} aria-label="Model">
							<option value="">模型</option>
							{#each catalog.filter((model) => model.provider === newProvider) as model (`${model.provider}/${model.id}`)}
								<option value={model.id}>{model.name}</option>
							{/each}
						</select>
						<select bind:value={newLevel} aria-label="Thinking level">
							{#each thinkingLevels as level (level)}
								<option value={level}>{level}</option>
							{/each}
						</select>
						<button class="secondary-button" type="button" disabled={saving || !newProvider || !newModelId} on:click={addOverride}>添加</button>
					</div>
				</section>

				<section class="settings-section">
					<h3>上下文压缩</h3>
					<label class="settings-check">
						<input type="checkbox" checked={settings.compaction.enabled} disabled={saving} on:change={(event) => void patch({ compactionEnabled: event.currentTarget.checked })} />
						<span>自动压缩过长的会话</span>
					</label>
					<label class="settings-field">
						<span>预留 token</span>
						<input type="number" min="0" step="1024" value={settings.compaction.reserveTokens} disabled={saving} on:change={(event) => saveNumber("compactionReserveTokens", event.currentTarget.value)} />
					</label>
					<label class="settings-field">
						<span>保留最近消息 token</span>
						<input type="number" min="0" step="1024" value={settings.compaction.keepRecentTokens} disabled={saving} on:change={(event) => saveNumber("compactionKeepRecentTokens", event.currentTarget.value)} />
					</label>
				</section>

				<section class="settings-section">
					<h3>消息队列与重试</h3>
					<label class="settings-field">
						<span>引导消息</span>
						<select disabled={saving} value={settings.steeringMode} on:change={(event) => void patch({ steeringMode: event.currentTarget.value })}>
							<option value="one-at-a-time">one at a time</option>
							<option value="all">all</option>
						</select>
					</label>
					<label class="settings-field">
						<span>后续消息</span>
						<select disabled={saving} value={settings.followUpMode} on:change={(event) => void patch({ followUpMode: event.currentTarget.value })}>
							<option value="one-at-a-time">one at a time</option>
							<option value="all">all</option>
						</select>
					</label>
					<label class="settings-check">
						<input type="checkbox" checked={settings.retry.enabled} disabled={saving} on:change={(event) => void patch({ retryEnabled: event.currentTarget.checked })} />
						<span>提供商请求失败时重试</span>
					</label>
				</section>
			{/if}
		</div>
	</div>
{/if}

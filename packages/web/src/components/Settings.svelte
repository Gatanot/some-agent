<script lang="ts">
	import { ChevronDown, ChevronRight, RotateCcw, RotateCw } from "@lucide/svelte";
	import { onMount } from "svelte";
	import type { WebProviderOption, WebSettings } from "../protocol.ts";
	import type { ModelOption } from "../types.ts";
	import { workspaceFetch } from "../workspace.ts";
	import SidePanel from "./SidePanel.svelte";

	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	let settings: WebSettings | undefined;
	let loading = false;
	let error = "";
	let saving = false;
	let requestId = 0;

	let catalog: ModelOption[] = [];
	let providers: WebProviderOption[] = [];
	let providerErrors: Record<string, string> = {};
	let providerNotices: Record<string, string> = {};
	let refreshingProvider = "";
	let modelQuery = "";
	let newProvider = "";
	let newModelId = "";
	let newLevel = "medium";

	let refreshingAll = false;
	let refreshNotice = "";
	let showUnconfigured = false;
	let expandedProviders: Record<string, boolean> = {};
	let expandedModelLists: Record<string, boolean> = {};
	const MODEL_PREVIEW_COUNT = 6;

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
		if (!Array.isArray(record.modelContextWindows)) return false;
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

	async function loadProviders(): Promise<void> {
		const response = await workspaceFetch("/api/providers");
		const payload = (await response.json()) as { providers?: WebProviderOption[]; error?: string };
		if (!response.ok) throw new Error(payload.error ?? "无法读取供应商列表");
		providers = payload.providers ?? [];
	}

	async function loadSettings(): Promise<void> {
		const id = ++requestId;
		loading = true;
		error = "";
		providerErrors = {};
		providerNotices = {};
		try {
			const [next] = await Promise.all([requestSettings("/api/settings"), loadCatalog(), loadProviders()]);
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

	async function refreshProvider(provider: string): Promise<void> {
		if (!provider) return;
		refreshingProvider = provider;
		providerErrors = { ...providerErrors, [provider]: "" };
		providerNotices = { ...providerNotices, [provider]: "" };
		try {
			const response = await workspaceFetch("/api/models/refresh", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider }),
			});
			const payload = (await response.json().catch(() => ({}))) as {
				errors?: string[];
				error?: string;
				providers?: WebProviderOption[];
				models?: ModelOption[];
			};
			if (!response.ok) throw new Error(payload.error ?? `刷新失败 (${response.status})`);
			if (payload.providers) providers = payload.providers;
			if (payload.models) catalog = payload.models;
			else await loadCatalog();
			const failure = (payload.errors ?? []).find((entry) => entry.startsWith(`${provider}:`));
			providerErrors = { ...providerErrors, [provider]: failure ?? "" };
			providerNotices = { ...providerNotices, [provider]: failure ? "" : "已拉取模型目录" };
		} catch (cause) {
			providerErrors = {
				...providerErrors,
				[provider]: cause instanceof Error ? cause.message : String(cause),
			};
		} finally {
			refreshingProvider = "";
		}
	}

	async function refreshAll(): Promise<void> {
		if (refreshingAll) return;
		refreshingAll = true;
		refreshNotice = "";
		error = "";
		try {
			const response = await workspaceFetch("/api/models/refresh", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			const payload = (await response.json().catch(() => ({}))) as {
				errors?: string[];
				error?: string;
				providers?: WebProviderOption[];
				models?: ModelOption[];
			};
			if (!response.ok) throw new Error(payload.error ?? `刷新失败 (${response.status})`);
			if (payload.providers) providers = payload.providers;
			else await loadProviders();
			if (payload.models) catalog = payload.models;
			else await loadCatalog();
			providerErrors = {};
			providerNotices = {};
			const failures = payload.errors ?? [];
			refreshNotice =
				failures.length > 0 ? `目录拉取完成，${failures.length} 个供应商失败` : "已拉取全部已配置供应商的模型目录";
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			refreshingAll = false;
		}
	}

	function toggleModel(model: ModelOption, checked: boolean): void {
		if (!settings) return;
		const key = modelKey(model);
		const current = settings.enabledModels ?? catalog.map(modelKey);
		const next = checked ? [...new Set([...current, key])] : current.filter((entry) => entry !== key);
		void patch({ enabledModels: next });
	}

	function toggleProviderModels(group: ProviderGroup, checked: boolean): void {
		if (!settings) return;
		const keys = new Set(group.allModels.map(modelKey));
		const current = settings.enabledModels ?? catalog.map(modelKey);
		const next = checked ? [...new Set([...current, ...keys])] : current.filter((entry) => !keys.has(entry));
		void patch({ enabledModels: next });
	}

	function saveDefaultModel(value: string): void {
		if (!value) return;
		void patch({ defaultModel: splitKey(value) });
	}

	function saveDefaultThinking(value: string): void {
		void patch({ defaultThinkingLevel: value });
	}

	function saveSubagentModel(value: string): void {
		if (!value) {
			void patch({ subagentModel: null });
			return;
		}
		void patch({ subagentModel: splitKey(value) });
	}

	function saveSubagentContextWindow(raw: string): void {
		const trimmed = raw.trim();
		if (trimmed === "") {
			void patch({ subagentContextWindow: null });
			return;
		}
		const parsed = Number.parseInt(trimmed, 10);
		if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) return;
		void patch({ subagentContextWindow: parsed });
	}

	function saveNumber(patchKey: string, raw: string): void {
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isInteger(parsed) || parsed < 0) return;
		void patch({ [patchKey]: parsed });
	}

	function contextOverride(model: ModelOption): string {
		const entry = settings?.modelContextWindows.find(
			(item) => item.provider === model.provider && item.id === model.id,
		);
		return entry ? String(entry.contextWindow) : "";
	}

	function saveContextWindow(model: ModelOption, raw: string): void {
		if (!settings) return;
		const trimmed = raw.trim();
		const next = settings.modelContextWindows.filter(
			(entry) => !(entry.provider === model.provider && entry.id === model.id),
		);
		if (trimmed !== "") {
			const parsed = Number.parseInt(trimmed, 10);
			if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) return;
			next.push({ provider: model.provider, id: model.id, contextWindow: parsed });
		}
		void patch({ modelContextWindows: next });
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

	interface ProviderGroup {
		id: string;
		name: string;
		configured: boolean;
		canRefresh: boolean;
		modelCount: number;
		availableCount: number;
		allModels: ModelOption[];
		models: ModelOption[];
		enabledCount: number;
		expanded: boolean;
		modelsExpanded: boolean;
		error: string;
		notice: string;
	}

	function providerMeta(group: ProviderGroup): string {
		const parts = [`${group.availableCount}/${group.modelCount} 可用`];
		if (group.configured) parts.push(`已启用 ${group.enabledCount}/${group.allModels.length}`);
		else parts.push("未配置认证");
		return parts.join(" · ");
	}

	function matchesQuery(model: ModelOption, query: string): boolean {
		if (!query) return true;
		return `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase());
	}

	function isModelEnabled(model: ModelOption, enabledModels: string[] | undefined): boolean {
		return enabledModels === undefined || enabledModels.includes(modelKey(model));
	}

	function buildProviderGroups(
		providerOptions: WebProviderOption[],
		models: ModelOption[],
		enabledModels: string[] | undefined,
		query: string,
		errors: Record<string, string>,
		notices: Record<string, string>,
		includeUnconfigured: boolean,
		expanded: Record<string, boolean>,
		expandedLists: Record<string, boolean>,
	): ProviderGroup[] {
		const knownProviders = new Set(providerOptions.map((provider) => provider.id));
		const extraProviders: WebProviderOption[] = [...new Set(models.map((model) => model.provider))]
			.filter((provider) => !knownProviders.has(provider))
			.map((provider) => ({ id: provider, name: provider, configured: true, canRefresh: false, modelCount: 0, availableCount: 0 }));
		const makeGroup = (provider: WebProviderOption): ProviderGroup => {
			const allModels = models.filter((model) => model.provider === provider.id);
			return {
				id: provider.id,
				name: provider.name,
				configured: provider.configured,
				canRefresh: provider.canRefresh,
				modelCount: provider.modelCount || allModels.length,
				availableCount: provider.availableCount || allModels.length,
				allModels,
				models: allModels.filter((model) => matchesQuery(model, query)),
				enabledCount: allModels.filter((model) => isModelEnabled(model, enabledModels)).length,
				expanded: expanded[provider.id] ?? provider.configured,
				modelsExpanded: expandedLists[provider.id] ?? false,
				error: errors[provider.id] || provider.error || "",
				notice: notices[provider.id] || "",
			};
		};
		return [...providerOptions, ...extraProviders]
			.map(makeGroup)
			.filter((group) => {
				const normalized = query.toLowerCase();
				if (normalized) {
					return (
						group.models.length > 0 ||
						group.id.toLowerCase().includes(normalized) ||
						group.name.toLowerCase().includes(normalized)
					);
				}
				return group.configured || includeUnconfigured;
			})
			.sort(
				(a, b) =>
					Number(b.configured) - Number(a.configured) ||
					a.name.localeCompare(b.name) ||
					a.id.localeCompare(b.id),
			);
	}

	function visibleModels(group: ProviderGroup): ModelOption[] {
		if (modelQuery || group.modelsExpanded) return group.models;
		return group.models.slice(0, MODEL_PREVIEW_COUNT);
	}

	function toggleExpandedProvider(group: ProviderGroup): void {
		expandedProviders = { ...expandedProviders, [group.id]: !group.expanded };
	}

	function toggleModelList(group: ProviderGroup): void {
		expandedModelLists = { ...expandedModelLists, [group.id]: !group.modelsExpanded };
	}

	function useIndeterminate(node: HTMLInputElement, value: boolean) {
		node.indeterminate = value;
		return {
			update(next: boolean): void {
				node.indeterminate = next;
			},
		};
	}

	$: defaultModelValue = settings?.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : "";
	$: subagentModelValue =
		settings?.subagent.provider && settings.subagent.model ? `${settings.subagent.provider}/${settings.subagent.model}` : "";
	$: subagentContextValue =
		settings?.subagent.contextWindow !== undefined ? String(settings.subagent.contextWindow) : "";
	$: subagentContextPlaceholder = subagentModelValue
		? String(catalog.find((model) => modelKey(model) === subagentModelValue)?.contextWindow ?? "模型默认值")
		: "跟随主代理";
	$: enabledModelKeys = settings?.enabledModels;
	$: availableModels = [...new Set(catalog.map((model) => model.provider))].map((provider) => ({
		provider,
		models: catalog.filter((model) => model.provider === provider),
	}));
	$: selectableModelGroups = [...new Set(catalog.map((model) => model.provider))]
		.map((provider) => ({
			provider,
			models: catalog.filter((model) => model.provider === provider && isModelEnabled(model, enabledModelKeys)),
		}))
		.filter((group) => group.models.length > 0);
	$: unconfiguredCount = providers.filter((provider) => !provider.configured).length;
	$: providerGroups = buildProviderGroups(
		providers,
		catalog,
		enabledModelKeys,
		modelQuery,
		providerErrors,
		providerNotices,
		showUnconfigured,
		expandedProviders,
		expandedModelLists,
	);

	onMount(() => {
		void loadSettings();
	});
</script>

<SidePanel title="设置" className="panel-settings">
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
							{#each selectableModelGroups as group (group.provider)}
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
					<h3>子代理</h3>
					<p class="settings-note">subagent 工具的默认模型与上下文窗口；留空时跟随主代理的当前设置。</p>
					<label class="settings-field">
						<span>默认模型</span>
						<select disabled={saving} value={subagentModelValue} on:change={(event) => saveSubagentModel(event.currentTarget.value)}>
							<option value="">跟随主代理</option>
							{#each selectableModelGroups as group (group.provider)}
								<optgroup label={group.provider}>
									{#each group.models as model (`${model.provider}/${model.id}`)}
										<option value={modelKey(model)}>{model.name}</option>
									{/each}
								</optgroup>
							{/each}
						</select>
					</label>
					<label class="settings-field">
						<span>上下文窗口</span>
						<input
							type="number"
							min="1"
							step="1024"
							value={subagentContextValue}
							placeholder={subagentContextPlaceholder}
							disabled={saving}
							on:change={(event) => saveSubagentContextWindow(event.currentTarget.value)}
						/>
					</label>
				</section>

				<section class="settings-section">
					<div class="settings-section-head">
						<h3>供应商与模型</h3>
						<button
							class="secondary-button"
							type="button"
							disabled={saving || refreshingAll || refreshingProvider !== ""}
							title="从所有已配置的供应商拉取模型目录"
							on:click={refreshAll}
						>
							<RotateCw size={14} class={refreshingAll ? "spin" : ""} />
							{refreshingAll ? "拉取中…" : "拉取全部"}
						</button>
					</div>
					<p class="settings-note">从供应商拉取可用模型目录，勾选要启用的模型；只有启用的模型显示上下文字段，留空时使用目录值。</p>
					<div class="model-toolbar">
						<input class="model-search" type="search" bind:value={modelQuery} aria-label="搜索模型" placeholder="搜索供应商或模型" />
						<label class="settings-check compact" title="显示没有配置认证的供应商">
							<input type="checkbox" bind:checked={showUnconfigured} />
							<span>未配置 ({unconfiguredCount})</span>
						</label>
					</div>
					{#if refreshNotice}<div class="provider-notice">{refreshNotice}</div>{/if}
					{#each providerGroups as group (group.id)}
						<div class="provider-block" class:unconfigured={!group.configured}>
							<div class="provider-head">
								<button class="provider-toggle" type="button" aria-expanded={group.expanded} on:click={() => toggleExpandedProvider(group)}>
									{#if group.expanded}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
									<span class="provider-identity">
										<strong>{group.name}</strong>
										<span class="provider-meta">{providerMeta(group)}</span>
									</span>
								</button>
								<div class="provider-actions">
									{#if group.allModels.length > 0}
										<label class="settings-check compact" title={`启用或停用 ${group.name} 的全部模型`}>
											<input
												type="checkbox"
												checked={group.enabledCount === group.allModels.length}
												use:indeterminate={group.enabledCount > 0 && group.enabledCount < group.allModels.length}
												disabled={saving}
												on:change={(event) => toggleProviderModels(group, event.currentTarget.checked)}
											/>
											<span>全选</span>
										</label>
									{/if}
									<button
										class="icon-button"
										type="button"
										title={group.canRefresh ? `从 ${group.name} 拉取模型目录` : `刷新 ${group.name} 的可用性`}
										aria-label={group.canRefresh ? `从 ${group.name} 拉取模型目录` : `刷新 ${group.name} 的可用性`}
										disabled={saving || refreshingAll || refreshingProvider === group.id}
										on:click={() => refreshProvider(group.id)}
									><RotateCw size={15} class={refreshingProvider === group.id ? "spin" : ""} /></button>
								</div>
							</div>
							{#if group.error}<div class="provider-error">{group.error}</div>{/if}
							{#if group.notice}<div class="provider-notice">{group.notice}</div>{/if}
							{#if group.expanded}
								{#if group.models.length === 0}
									<p class="settings-note">{modelQuery ? "没有匹配的模型。" : group.configured ? "没有可用模型。" : "未配置认证，无法列出可用模型。"}</p>
								{:else}
									<div class="model-list">
										{#each visibleModels(group) as model (`${model.provider}/${model.id}`)}
											<div class="model-row">
												<label class="settings-check"><input type="checkbox" checked={isModelEnabled(model, enabledModelKeys)} disabled={saving} on:change={(event) => toggleModel(model, event.currentTarget.checked)} /><span>{model.name} <small>{model.id}</small></span></label>
												{#if isModelEnabled(model, enabledModelKeys)}
													<div class="context-field" title={`${model.name} 的上下文窗口（tokens），留空使用目录值`}>
														<input type="number" min="1" step="1024" value={contextOverride(model)} placeholder={model.contextWindow ? String(model.contextWindow) : "默认"} disabled={saving} on:change={(event) => saveContextWindow(model, event.currentTarget.value)} />
														<span>context</span>
														{#if contextOverride(model)}
															<button class="context-reset" type="button" title="恢复目录上下文窗口" aria-label="恢复目录上下文窗口" disabled={saving} on:click={() => saveContextWindow(model, "")}><RotateCcw size={13} /></button>
														{/if}
													</div>
												{/if}
											</div>
										{/each}
									</div>
									{#if !modelQuery && group.models.length > MODEL_PREVIEW_COUNT}
										<button class="quiet-button model-more" type="button" on:click={() => toggleModelList(group)}>
											{group.modelsExpanded ? "收起" : `显示其余 ${group.models.length - MODEL_PREVIEW_COUNT} 个`}
										</button>
									{/if}
								{/if}
							{/if}
						</div>
					{/each}
					{#if providerGroups.length === 0}
						<p class="settings-note">没有匹配的供应商。</p>
					{/if}
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
</SidePanel>

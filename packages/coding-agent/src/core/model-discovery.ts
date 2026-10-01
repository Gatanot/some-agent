import type { Api, Model, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { fetchWithRetry } from "../utils/management-http.ts";
import type { ModelsJsonModel, ModelsJsonProvider } from "./model-config.ts";

const DISCOVERY_FRESHNESS_MS = 5 * 60 * 1000;
const DISCOVERY_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_DISCOVERED_CONTEXT_WINDOW = 128_000;
const DEFAULT_DISCOVERED_MAX_TOKENS = 16_384;
const DISCOVERABLE_APIS = new Set<string>(["openai-completions", "openai-responses"]);
const DISCOVERABLE_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface DiscoveredModel {
	id: string;
	name?: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
}

export type ModelDiscoveryRefresh = (context: RefreshModelsContext) => Promise<void>;

export interface ModelDiscoveryOptions {
	providerId: string;
	config: ModelsJsonProvider | undefined;
	/** Replace the provider's discovered catalog with the given models. */
	setModels: (models: readonly Model<Api>[]) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDiscoveryApi(config: ModelsJsonProvider | undefined): string | undefined {
	if (!config?.baseUrl) return undefined;
	const candidates: (string | undefined)[] = [
		config.api,
		...(config.models ?? []).map((model: ModelsJsonModel) => model.api),
	];
	for (const candidate of candidates) {
		if (candidate && DISCOVERABLE_APIS.has(candidate)) return candidate;
	}
	return undefined;
}

/** Whether a models.json-only provider can list its catalog over an OpenAI-compatible `/models` endpoint. */
export function supportsOpenAICompatibleDiscovery(config: ModelsJsonProvider | undefined): boolean {
	return resolveDiscoveryApi(config) !== undefined;
}

function thinkingLevelMapFromEfforts(values: readonly string[]): ThinkingLevelMap {
	const map: ThinkingLevelMap = { off: values.includes("none") ? "none" : null };
	for (const level of DISCOVERABLE_THINKING_LEVELS) {
		map[level] = values.includes(level) ? level : null;
	}
	return map;
}

/**
 * Reads the loosely specified OpenAI-compatible model list payloads, accepting
 * `{ data: [...] }`, `{ models: [...] }`, or a bare array of strings/objects.
 */
function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
	const entries = Array.isArray(value)
		? value
		: isPlainObject(value) && Array.isArray(value.data)
			? value.data
			: isPlainObject(value) && Array.isArray(value.models)
				? value.models
				: undefined;
	if (!entries) throw new Error("Model list response does not contain a model array");

	const models = new Map<string, DiscoveredModel>();
	for (const raw of entries) {
		const record = isPlainObject(raw) ? raw : undefined;
		const id =
			typeof raw === "string"
				? raw.trim()
				: typeof record?.id === "string"
					? record.id.trim()
					: typeof record?.model === "string"
						? record.model.trim()
						: "";
		if (!id) continue;

		const capabilities = isPlainObject(record?.capabilities) ? record.capabilities : undefined;
		const modalities = Array.isArray(capabilities?.input_modalities)
			? capabilities.input_modalities.filter((entry): entry is string => typeof entry === "string")
			: [];
		const supportsImage = capabilities?.vision === true || modalities.includes("image");
		const reasoningInfo = isPlainObject(capabilities?.reasoning) ? capabilities.reasoning : undefined;
		const effortValues = Array.isArray(reasoningInfo?.effort_values)
			? reasoningInfo.effort_values.filter((entry): entry is string => typeof entry === "string")
			: undefined;
		const reasoning = effortValues !== undefined || capabilities?.reasoning === true;
		const name =
			typeof record?.display_name === "string"
				? record.display_name
				: typeof record?.name === "string"
					? record.name
					: undefined;

		models.set(id, {
			id,
			...(name ? { name } : {}),
			reasoning,
			...(effortValues && effortValues.length > 0
				? { thinkingLevelMap: thinkingLevelMapFromEfforts(effortValues) }
				: {}),
			input: supportsImage ? ["text", "image"] : ["text"],
		});
	}
	return [...models.values()];
}

function toModel(providerId: string, api: string, baseUrl: string, discovered: DiscoveredModel): Model<Api> {
	return {
		id: discovered.id,
		name: discovered.name ?? discovered.id,
		api: api as Api,
		provider: providerId,
		baseUrl,
		reasoning: discovered.reasoning,
		...(discovered.thinkingLevelMap ? { thinkingLevelMap: discovered.thinkingLevelMap } : {}),
		input: discovered.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_DISCOVERED_CONTEXT_WINDOW,
		maxTokens: DEFAULT_DISCOVERED_MAX_TOKENS,
	};
}

function discoveryError(providerId: string, response: Response, body: string): Error {
	const detail = body.trim().slice(0, 300);
	return new Error(`Model list request failed for ${providerId}: ${response.status}${detail ? ` ${detail}` : ""}`);
}

/**
 * Builds a `refreshModels` implementation that lists models from a models.json-only
 * OpenAI-compatible provider and persists them through the shared models store.
 * Returns undefined for built-in/extension providers and non-discoverable APIs.
 */
export function createModelDiscovery(options: ModelDiscoveryOptions): ModelDiscoveryRefresh | undefined {
	const { providerId, config } = options;
	const api = resolveDiscoveryApi(config);
	const baseUrl = config?.baseUrl;
	if (!api || !baseUrl) return undefined;

	return async (context) => {
		const stored = context.stored;
		if (stored) {
			const restored = stored.models.filter((model) => model.provider === providerId);
			if (!(await context.publish({ update: () => options.setModels(restored) }))) return;
		}
		if (!context.allowNetwork || context.signal.aborted) return;
		if (!context.force && stored?.checkedAt !== undefined && Date.now() - stored.checkedAt < DISCOVERY_FRESHNESS_MS) {
			return;
		}

		const credential = context.credential;
		const apiKey = credential?.type === "oauth" ? credential.access : credential?.key;
		const url = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
		const response = await fetchWithRetry(
			url,
			{
				headers: {
					accept: "application/json",
					...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
				},
				signal: context.signal,
			},
			{ attemptTimeoutMs: DISCOVERY_ATTEMPT_TIMEOUT_MS },
		);
		if (context.signal.aborted) return;
		if (!response.ok) throw discoveryError(providerId, response, await response.text().catch(() => ""));

		const parsed: unknown = await response.json();
		const models = parseDiscoveredModels(parsed).map((entry) => toModel(providerId, api, baseUrl, entry));
		if (context.signal.aborted) return;
		await context.publish({
			persist: { models, checkedAt: Date.now() },
			update: () => options.setModels(models),
		});
	};
}

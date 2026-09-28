import { parseHTML } from "linkedom";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { canonicalizeWebUrl, collapseWhitespace, WebToolError } from "./web-common.ts";
import { recordWebToolCall, type WebToolCallRecorder } from "./web-history.ts";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;

const webSearchSchema = Type.Object(
	{
		query: Type.String({ description: "Search query", minLength: 1 }),
		maxResults: Type.Optional(
			Type.Integer({ description: "Result count", default: DEFAULT_MAX_RESULTS, minimum: 1, maximum: MAX_RESULTS }),
		),
		freshness: Type.Optional(
			Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
				description: "Maximum result age",
			}),
		),
		includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only these domains", maxItems: 10 })),
		excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains", maxItems: 10 })),
	},
	{ additionalProperties: false },
);

export type WebSearchInput = Static<typeof webSearchSchema>;
export type WebSearchFreshness = NonNullable<WebSearchInput["freshness"]>;

export interface WebSearchRequest {
	query: string;
	maxResults: number;
	freshness?: WebSearchFreshness;
	includeDomains?: string[];
	excludeDomains?: string[];
}

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedAt?: string;
}

export interface WebSearchProvider {
	search(request: WebSearchRequest, signal?: AbortSignal): Promise<readonly WebSearchResult[]>;
}

export interface WebSearchToolDetails {
	resultCount: number;
}

export interface WebSearchToolOptions {
	provider: WebSearchProvider;
	history?: WebToolCallRecorder;
	onHistoryError?: (error: Error) => void;
	now?: () => Date;
}

function normalizeDomain(domain: string): string {
	const value = collapseWhitespace(domain).toLowerCase();
	if (!value || /\s/.test(value)) throw new WebToolError("invalid_arguments", `Invalid domain filter: ${domain}`);
	let url: URL;
	try {
		url = new URL(value.includes("://") ? value : `http://${value}`);
	} catch (cause) {
		throw new WebToolError(
			"invalid_arguments",
			`Invalid domain filter: ${domain}`,
			cause instanceof Error ? cause : undefined,
		);
	}
	if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
		throw new WebToolError("invalid_arguments", `Invalid domain filter: ${domain}`);
	}
	return url.hostname;
}

function normalizeDomains(domains: string[] | undefined): string[] | undefined {
	if (!domains) return undefined;
	const normalized = [...new Set(domains.map(normalizeDomain))];
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeResult(result: WebSearchResult): WebSearchResult | undefined {
	let url: string;
	try {
		url = canonicalizeWebUrl(result.url);
	} catch {
		return undefined;
	}
	const title = collapseWhitespace(result.title);
	const snippet = collapseWhitespace(result.snippet);
	if (!title || !snippet) return undefined;
	const publishedAt = result.publishedAt === undefined ? undefined : collapseWhitespace(result.publishedAt);
	return { title, url, snippet, ...(publishedAt ? { publishedAt } : {}) };
}

export function createWebSearchTool(
	options: WebSearchToolOptions,
): AgentHarnessTool<undefined, typeof webSearchSchema, WebSearchToolDetails> {
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web. Returns untrusted titles, URLs, snippets, and publication times.",
		parameters: webSearchSchema,
		async execute(toolCallId, params, signal) {
			const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
			if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
				throw new WebToolError("invalid_arguments", `maxResults must be an integer from 1 to ${MAX_RESULTS}`);
			}
			const request: WebSearchRequest = {
				query: params.query.trim(),
				maxResults,
				freshness: params.freshness,
				includeDomains: normalizeDomains(params.includeDomains),
				excludeDomains: normalizeDomains(params.excludeDomains),
			};
			if (!request.query) throw new WebToolError("invalid_arguments", "Search query must not be blank");
			await recordWebToolCall(
				options.history,
				{
					schemaVersion: 1,
					toolCallId,
					tool: "web_search",
					timestamp: (options.now?.() ?? new Date()).toISOString(),
					suppliedArguments: structuredClone(params),
					resolvedArguments: structuredClone({
						query: request.query,
						maxResults: request.maxResults,
						...(request.freshness ? { freshness: request.freshness } : {}),
						...(request.includeDomains ? { includeDomains: request.includeDomains } : {}),
						...(request.excludeDomains ? { excludeDomains: request.excludeDomains } : {}),
					}),
				},
				options.onHistoryError,
			);

			const results: WebSearchResult[] = [];
			const seen = new Set<string>();
			for (const rawResult of await options.provider.search(request, signal)) {
				const result = normalizeResult(rawResult);
				if (!result || seen.has(result.url)) continue;
				seen.add(result.url);
				results.push(result);
				if (results.length >= request.maxResults) break;
			}
			return {
				content: [{ type: "text", text: JSON.stringify(results) }],
				details: { resultCount: results.length },
			};
		},
	};
}

export interface BraveWebSearchOptions {
	apiKey: string;
	endpoint?: string;
	fetch?: typeof fetch;
	country?: string;
	searchLanguage?: string;
	safeSearch?: "off" | "moderate" | "strict";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function htmlFragmentText(value: string): string {
	return collapseWhitespace(parseHTML(`<html><body>${value}</body></html>`).document.body?.textContent ?? value);
}

function appendDomainFilters(query: string, include: string[] | undefined, exclude: string[] | undefined): string {
	const terms = [query];
	for (const domain of include ?? []) terms.push(`site:${domain}`);
	for (const domain of exclude ?? []) terms.push(`-site:${domain}`);
	return terms.join(" ");
}

export function createBraveWebSearch(options: BraveWebSearchOptions): WebSearchProvider {
	const requestFetch = options.fetch ?? fetch;
	const endpoint = options.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
	return {
		async search(request, signal) {
			const url = new URL(endpoint);
			url.searchParams.set("q", appendDomainFilters(request.query, request.includeDomains, request.excludeDomains));
			url.searchParams.set("count", String(request.maxResults));
			if (request.freshness) {
				url.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[request.freshness]);
			}
			if (options.country) url.searchParams.set("country", options.country);
			if (options.searchLanguage) url.searchParams.set("search_lang", options.searchLanguage);
			if (options.safeSearch) url.searchParams.set("safesearch", options.safeSearch);

			let response: Response;
			try {
				response = await requestFetch(url, {
					headers: { Accept: "application/json", "X-Subscription-Token": options.apiKey },
					signal,
				});
			} catch (cause) {
				if (signal?.aborted) throw new WebToolError("aborted", "Web search aborted");
				throw new WebToolError(
					"upstream_error",
					"Web search request failed",
					cause instanceof Error ? cause : undefined,
				);
			}
			if (response.status === 401 || response.status === 403) {
				throw new WebToolError("authentication", `Web search authentication failed with HTTP ${response.status}`);
			}
			if (response.status === 429) throw new WebToolError("rate_limited", "Web search rate limit exceeded");
			if (!response.ok) throw new WebToolError("upstream_error", `Web search failed with HTTP ${response.status}`);
			let payload: unknown;
			try {
				payload = await response.json();
			} catch (cause) {
				throw new WebToolError(
					"invalid_response",
					"Web search returned invalid JSON",
					cause instanceof Error ? cause : undefined,
				);
			}
			const web = objectValue(objectValue(payload)?.web);
			const rawResults = web?.results;
			if (!Array.isArray(rawResults)) throw new WebToolError("invalid_response", "Web search returned invalid JSON");
			return rawResults.flatMap((value): WebSearchResult[] => {
				const item = objectValue(value);
				const title = stringValue(item?.title);
				const resultUrl = stringValue(item?.url);
				const description = stringValue(item?.description);
				if (!title || !resultUrl || !description) return [];
				const publishedAt = stringValue(item?.page_age) ?? stringValue(item?.age);
				return [
					{
						title: htmlFragmentText(title),
						url: resultUrl,
						snippet: htmlFragmentText(description),
						...(publishedAt ? { publishedAt } : {}),
					},
				];
			});
		},
	};
}

import { createWebFetchTool, type WebFetchToolOptions } from "./web-fetch.ts";
import { InMemoryWebToolCallHistory, type WebToolCallRecorder } from "./web-history.ts";
import { createWebSearchTool, type WebSearchProvider, type WebSearchToolOptions } from "./web-search.ts";

export interface WebToolsOptions {
	searchProvider: WebSearchProvider;
	history?: WebToolCallRecorder;
	search?: Omit<WebSearchToolOptions, "provider" | "history">;
	fetch?: Omit<WebFetchToolOptions, "history">;
}

export interface WebTools {
	history: WebToolCallRecorder;
	webSearch: ReturnType<typeof createWebSearchTool>;
	webFetch: ReturnType<typeof createWebFetchTool>;
	tools: readonly [ReturnType<typeof createWebSearchTool>, ReturnType<typeof createWebFetchTool>];
}

/** Creates both web tools with one shared argument-only call history. */
export function createWebTools(options: WebToolsOptions): WebTools {
	const history = options.history ?? new InMemoryWebToolCallHistory();
	const webSearch = createWebSearchTool({ ...options.search, provider: options.searchProvider, history });
	const webFetch = createWebFetchTool({ ...options.fetch, history });
	return {
		history,
		webSearch,
		webFetch,
		tools: [webSearch, webFetch] as const,
	};
}

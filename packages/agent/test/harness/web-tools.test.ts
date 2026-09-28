import { describe, expect, it } from "vitest";
import { WebToolError } from "../../src/harness/tools/web-common.ts";
import { createWebFetchTool } from "../../src/harness/tools/web-fetch.ts";
import { InMemoryWebToolCallHistory } from "../../src/harness/tools/web-history.ts";
import {
	createBraveWebSearch,
	createWebSearchTool,
	type WebSearchProvider,
	type WebSearchRequest,
} from "../../src/harness/tools/web-search.ts";
import { createWebTools } from "../../src/harness/tools/web-tools.ts";

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
	return new Response(html, {
		...init,
		headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
	});
}

const ARTICLE_HTML = `<!doctype html>
<html>
<head>
  <title>Example article</title>
  <meta name="author" content="Ada Example">
  <meta property="article:published_time" content="2026-04-10T09:30:00Z">
  <script>globalThis.pwned = true</script>
  <style>.ad { display: block }</style>
</head>
<body>
  <nav>Home Products Pricing Contact</nav>
  <aside class="ad">Buy unrelated products now</aside>
  <article>
    <h1>Structured extraction</h1>
    <p>This is the first substantial paragraph. It contains enough useful prose for the article extractor to identify the main content without relying on navigation or advertising text.</p>
    <p>This is the second substantial paragraph with <strong>important details</strong>, an <a href="/docs">internal documentation link</a>, and more explanatory text for reliable extraction.</p>
    <a href="javascript:alert(1)" onclick="alert(1)">Unsafe link</a>
    <ul><li>First item</li><li>Second item</li></ul>
    <pre><code>const value = 42;</code></pre>
  </article>
  <footer>Privacy Terms Careers</footer>
</body>
</html>`;

describe("web_search", () => {
	it("keeps the model-visible schema compact and records supplied and resolved arguments only", async () => {
		let received: WebSearchRequest | undefined;
		const provider: WebSearchProvider = {
			async search(request) {
				received = request;
				return [
					{
						title: " Result one ",
						url: "https://example.com/page?utm_source=test",
						snippet: " First   snippet ",
						publishedAt: " 2026-04-10 ",
					},
					{
						title: "Duplicate",
						url: "https://example.com/page",
						snippet: "Duplicate URL",
					},
					{ title: "Invalid", url: "ftp://example.com/file", snippet: "Ignored" },
				];
			},
		};
		const history = new InMemoryWebToolCallHistory();
		const tool = createWebSearchTool({ provider, history, now: () => new Date("2026-04-10T10:00:00Z") });

		const result = await tool.execute(
			"search-1",
			{ query: "  compact web tools  ", includeDomains: ["Example.COM", "example.com"] },
			undefined,
			undefined,
			undefined,
		);

		expect(tool.description.length).toBeLessThan(100);
		expect(Object.keys(tool.parameters.properties)).toEqual([
			"query",
			"maxResults",
			"freshness",
			"includeDomains",
			"excludeDomains",
		]);
		expect(tool.parameters.properties.maxResults).toMatchObject({ default: 5 });
		expect(received).toEqual({
			query: "compact web tools",
			maxResults: 5,
			freshness: undefined,
			includeDomains: ["example.com"],
			excludeDomains: undefined,
		});
		expect(JSON.parse(textOutput(result))).toEqual([
			{
				title: "Result one",
				url: "https://example.com/page",
				snippet: "First snippet",
				publishedAt: "2026-04-10",
			},
		]);
		expect(history.list()).toEqual([
			{
				schemaVersion: 1,
				toolCallId: "search-1",
				tool: "web_search",
				timestamp: "2026-04-10T10:00:00.000Z",
				suppliedArguments: {
					query: "  compact web tools  ",
					includeDomains: ["Example.COM", "example.com"],
				},
				resolvedArguments: {
					query: "compact web tools",
					maxResults: 5,
					includeDomains: ["example.com"],
				},
			},
		]);
		expect(history.list()[0]).not.toHaveProperty("result");
	});

	it("creates both tools with a shared history by default", async () => {
		const web = createWebTools({
			searchProvider: { search: async () => [] },
			fetch: { fetch: async () => new Response("plain text", { headers: { "content-type": "text/plain" } }) },
		});

		await web.webSearch.execute("search-shared", { query: "test" }, undefined, undefined, undefined);
		await web.webFetch.execute("fetch-shared", { url: "https://example.com/" }, undefined, undefined, undefined);

		expect(web.tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
		expect(web.history).toBeInstanceOf(InMemoryWebToolCallHistory);
		expect((web.history as InMemoryWebToolCallHistory).list().map((call) => call.tool)).toEqual([
			"web_search",
			"web_fetch",
		]);
	});

	it("adapts Brave responses without exposing provider fields", async () => {
		let requestedUrl: URL | undefined;
		let requestedHeaders: Headers | undefined;
		const provider = createBraveWebSearch({
			apiKey: "secret",
			fetch: async (input, init) => {
				requestedUrl = new URL(String(input));
				requestedHeaders = new Headers(init?.headers);
				return Response.json({
					web: {
						results: [
							{
								title: "A <strong>result</strong>",
								url: "https://example.com/a",
								description: "Useful <strong>snippet</strong>",
								page_age: "2026-04-09T00:00:00Z",
								extra_snippets: ["must not leak"],
							},
						],
					},
				});
			},
		});

		const results = await provider.search({
			query: "test",
			maxResults: 3,
			freshness: "week",
			includeDomains: ["docs.example.com"],
			excludeDomains: ["old.example.com"],
		});

		expect(requestedUrl?.searchParams.get("q")).toBe("test site:docs.example.com -site:old.example.com");
		expect(requestedUrl?.searchParams.get("count")).toBe("3");
		expect(requestedUrl?.searchParams.get("freshness")).toBe("pw");
		expect(requestedHeaders?.get("X-Subscription-Token")).toBe("secret");
		expect(results).toEqual([
			{
				title: "A result",
				url: "https://example.com/a",
				snippet: "Useful snippet",
				publishedAt: "2026-04-09T00:00:00Z",
			},
		]);
	});
});

describe("web_fetch", () => {
	it("extracts compact Markdown by default and records the resolved clean default", async () => {
		const history = new InMemoryWebToolCallHistory();
		const tool = createWebFetchTool({
			history,
			now: () => new Date("2026-04-10T10:00:00Z"),
			fetch: async () => htmlResponse(ARTICLE_HTML),
		});

		const result = await tool.execute(
			"fetch-1",
			{ url: "https://example.com/articles/one" },
			undefined,
			undefined,
			undefined,
		);
		const output = textOutput(result);

		expect(tool.description.length).toBeLessThan(100);
		expect(Object.keys(tool.parameters.properties)).toEqual(["url", "clean"]);
		expect(tool.parameters.properties.clean).toMatchObject({ default: true });
		expect(output).toContain("Title: Example article");
		expect(output).toContain("Author: Ada Example");
		expect(output).toContain("Published: 2026-04-10T09:30:00Z");
		expect(output).toContain("## Structured extraction");
		expect(output).toContain("**important details**");
		expect(output).toContain("[internal documentation link](https://example.com/docs)");
		expect(output).toContain("- First item");
		expect(output).toContain("const value = 42;");
		expect(output).not.toContain("Buy unrelated products");
		expect(output).not.toContain("globalThis.pwned");
		expect(output).not.toContain("<article>");
		expect(history.list()[0]).toMatchObject({
			tool: "web_fetch",
			suppliedArguments: { url: "https://example.com/articles/one" },
			resolvedArguments: { url: "https://example.com/articles/one", clean: true },
		});
		expect(history.list()[0]).not.toHaveProperty("result");
	});

	it("returns sanitized HTML when clean is false", async () => {
		const tool = createWebFetchTool({ fetch: async () => htmlResponse(ARTICLE_HTML) });

		const result = await tool.execute(
			"fetch-raw",
			{ url: "https://example.com/articles/one", clean: false },
			undefined,
			undefined,
			undefined,
		);
		const output = textOutput(result);

		expect(output).toContain("<article>");
		expect(output).toContain('href="https://example.com/docs"');
		expect(output).not.toContain("<script>");
		expect(output).not.toContain("<style>");
		expect(output).not.toContain("onclick=");
		expect(output).not.toContain("javascript:");
	});

	it("blocks redirects to private addresses before issuing the redirected request", async () => {
		let requests = 0;
		const tool = createWebFetchTool({
			fetch: async () => {
				requests += 1;
				return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
			},
		});

		let error: unknown;
		try {
			await tool.execute("fetch-private", { url: "https://example.com/redirect" }, undefined, undefined, undefined);
		} catch (cause) {
			error = cause;
		}

		expect(error).toBeInstanceOf(WebToolError);
		expect((error as WebToolError).code).toBe("private_url");
		expect(requests).toBe(1);
	});

	it("reports request timeouts separately from caller cancellation", async () => {
		const tool = createWebFetchTool({
			timeoutMs: 5,
			fetch: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		});

		await expect(
			tool.execute("fetch-timeout", { url: "https://example.com/slow" }, undefined, undefined, undefined),
		).rejects.toMatchObject({ code: "timeout" });
	});

	it("rejects oversized responses before reading their body", async () => {
		const tool = createWebFetchTool({
			maxResponseBytes: 16,
			fetch: async () =>
				new Response("too large", {
					headers: { "content-type": "text/plain", "content-length": "100" },
				}),
		});

		await expect(
			tool.execute("fetch-large", { url: "https://example.com/large" }, undefined, undefined, undefined),
		).rejects.toMatchObject({ code: "response_too_large" });
	});
});

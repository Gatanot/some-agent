import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { collapseWhitespace, normalizeHttpUrl, WebToolError } from "./web-common.ts";
import { recordWebToolCall, type WebToolCallRecorder } from "./web-history.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

const webFetchSchema = Type.Object(
	{
		url: Type.String({ description: "HTTP(S) URL", minLength: 1 }),
		clean: Type.Optional(Type.Boolean({ description: "Return compact Markdown", default: true })),
	},
	{ additionalProperties: false },
);

export type WebFetchInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	url: string;
	contentType: string;
	contentLength: number;
	truncated: boolean;
}

export interface WebFetchToolOptions {
	fetch?: typeof fetch;
	history?: WebToolCallRecorder;
	onHistoryError?: (error: Error) => void;
	now?: () => Date;
	timeoutMs?: number;
	maxRedirects?: number;
	maxResponseBytes?: number;
	maxContentChars?: number;
	allowPrivateAddresses?: boolean;
	headers?: Record<string, string>;
}

interface DomNode {
	nodeType: number;
	textContent: string | null;
	childNodes: ArrayLike<DomNode>;
}

interface DomElement extends DomNode {
	tagName: string;
	innerHTML: string;
	outerHTML: string;
	getAttribute(name: string): string | null;
	getAttributeNames(): ArrayLike<string>;
	removeAttribute(name: string): void;
	setAttribute(name: string, value: string): void;
	remove(): void;
	querySelector(selector: string): DomElement | null;
	querySelectorAll(selector: string): ArrayLike<DomElement>;
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
	const octets = parts.map(Number);
	if (octets.some((octet) => octet > 255)) return false;
	const [first, second] = octets;
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second !== undefined && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		(first === 100 && second !== undefined && second >= 64 && second <= 127) ||
		(first !== undefined && first >= 224)
	);
}

function assertPublicUrl(url: URL, allowPrivateAddresses: boolean): void {
	if (allowPrivateAddresses) return;
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		isPrivateIpv4(hostname) ||
		hostname === "::" ||
		hostname === "::1" ||
		(hostname.startsWith("::ffff:") && isPrivateIpv4(hostname.slice("::ffff:".length))) ||
		hostname.startsWith("fc") ||
		hostname.startsWith("fd") ||
		hostname.startsWith("fe80:")
	) {
		throw new WebToolError("private_url", `Private URL is not allowed: ${url.hostname}`);
	}
}

function createRequestSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): {
	signal: AbortSignal;
	timedOut: () => boolean;
	dispose: () => void;
} {
	const controller = new AbortController();
	let timeoutElapsed = false;
	const abort = (): void => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		timeoutElapsed = true;
		controller.abort(new Error(`Web fetch timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	return {
		signal: controller.signal,
		timedOut: () => timeoutElapsed,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}

async function fetchWithRedirects(
	requestFetch: typeof fetch,
	initialUrl: URL,
	options: Required<Pick<WebFetchToolOptions, "allowPrivateAddresses" | "maxRedirects">> & {
		headers: Record<string, string>;
		signal: AbortSignal;
	},
): Promise<{ response: Response; finalUrl: URL }> {
	let currentUrl = initialUrl;
	for (let redirectCount = 0; ; redirectCount += 1) {
		assertPublicUrl(currentUrl, options.allowPrivateAddresses);
		let response: Response;
		try {
			response = await requestFetch(currentUrl, {
				headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1", ...options.headers },
				redirect: "manual",
				signal: options.signal,
			});
		} catch (cause) {
			if (options.signal.aborted) throw new WebToolError("aborted", "Web fetch aborted");
			throw new WebToolError(
				"upstream_error",
				"Web fetch request failed",
				cause instanceof Error ? cause : undefined,
			);
		}
		if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: currentUrl };
		const location = response.headers.get("location");
		if (!location) throw new WebToolError("invalid_response", "Redirect response has no Location header");
		await response.body?.cancel();
		if (redirectCount >= options.maxRedirects) {
			throw new WebToolError("too_many_redirects", `Web fetch exceeded ${options.maxRedirects} redirects`);
		}
		currentUrl = normalizeHttpUrl(new URL(location, currentUrl).toString());
	}
}

async function readResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new WebToolError("response_too_large", `Web response exceeds ${maxBytes} bytes`);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new WebToolError("response_too_large", `Web response exceeds ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function decodeResponse(bytes: Uint8Array, contentType: string): string {
	const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

function absoluteUrl(value: string | null, baseUrl: string): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value, baseUrl);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function sanitizeDocument(root: DomElement, baseUrl: string): void {
	for (const element of Array.from(
		root.querySelectorAll("script,style,noscript,template,iframe,object,embed,canvas,svg,link,meta[http-equiv]"),
	)) {
		element.remove();
	}
	for (const element of Array.from(root.querySelectorAll("*"))) {
		for (const name of Array.from(element.getAttributeNames())) {
			const normalized = name.toLowerCase();
			if (normalized.startsWith("on") || ["style", "srcdoc", "nonce"].includes(normalized)) {
				element.removeAttribute(name);
			}
		}
		for (const attribute of ["href", "src", "poster"] as const) {
			if (!element.getAttribute(attribute)) continue;
			const resolved = absoluteUrl(element.getAttribute(attribute), baseUrl);
			if (resolved) element.setAttribute(attribute, resolved);
			else element.removeAttribute(attribute);
		}
	}
}

function escapeMarkdown(value: string): string {
	return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function markdownChildren(node: DomNode, baseUrl: string, inPre = false): string {
	return Array.from(node.childNodes)
		.map((child) => markdownNode(child, baseUrl, inPre))
		.join("");
}

function markdownNode(node: DomNode, baseUrl: string, inPre = false): string {
	if (node.nodeType === 3) {
		const text = node.textContent ?? "";
		return inPre ? text : escapeMarkdown(text.replace(/\s+/g, " "));
	}
	if (node.nodeType !== 1) return "";
	const element = node as DomElement;
	const tag = element.tagName.toLowerCase();
	if (["script", "style", "noscript", "template"].includes(tag)) return "";
	if (tag === "br") return "\n";
	if (tag === "hr") return "\n\n---\n\n";
	if (/^h[1-6]$/.test(tag))
		return `\n\n${"#".repeat(Number(tag[1]))} ${markdownChildren(element, baseUrl).trim()}\n\n`;
	if (tag === "p" || tag === "div" || tag === "article" || tag === "section" || tag === "main") {
		return `\n\n${markdownChildren(element, baseUrl).trim()}\n\n`;
	}
	if (tag === "strong" || tag === "b") return `**${markdownChildren(element, baseUrl).trim()}**`;
	if (tag === "em" || tag === "i") return `*${markdownChildren(element, baseUrl).trim()}*`;
	if (tag === "del" || tag === "s") return `~~${markdownChildren(element, baseUrl).trim()}~~`;
	if (tag === "code" && !inPre) return `\`${(element.textContent ?? "").replace(/`/g, "\\`")}\``;
	if (tag === "pre") return `\n\n\`\`\`\n${(element.textContent ?? "").trim()}\n\`\`\`\n\n`;
	if (tag === "a") {
		const label = markdownChildren(element, baseUrl).trim();
		const href = absoluteUrl(element.getAttribute("href"), baseUrl);
		return href && label ? `[${label}](${href})` : label;
	}
	if (tag === "img") {
		const alt = collapseWhitespace(element.getAttribute("alt") ?? "");
		const src = absoluteUrl(element.getAttribute("src"), baseUrl);
		return src && alt ? `![${escapeMarkdown(alt)}](${src})` : "";
	}
	if (tag === "li") return markdownChildren(element, baseUrl).trim();
	if (tag === "ul" || tag === "ol") {
		const items = Array.from(element.childNodes).filter(
			(child) => child.nodeType === 1 && (child as DomElement).tagName.toLowerCase() === "li",
		);
		return `\n\n${items
			.map((item, index) => `${tag === "ol" ? `${index + 1}.` : "-"} ${markdownNode(item, baseUrl).trim()}`)
			.join("\n")}\n\n`;
	}
	if (tag === "blockquote") {
		return `\n\n${markdownChildren(element, baseUrl)
			.trim()
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")}\n\n`;
	}
	if (tag === "tr") {
		const cells = Array.from(element.childNodes)
			.filter((child) => child.nodeType === 1 && ["td", "th"].includes((child as DomElement).tagName.toLowerCase()))
			.map((cell) => markdownChildren(cell, baseUrl).trim().replace(/\|/g, "\\|"));
		return cells.length > 0 ? `| ${cells.join(" | ")} |\n` : "";
	}
	if (tag === "table") return `\n\n${markdownChildren(element, baseUrl).trim()}\n\n`;
	return markdownChildren(element, baseUrl, inPre || tag === "pre");
}

function extractMetaContent(document: DomElement, selectors: string[]): string | undefined {
	for (const selector of selectors) {
		const value = document.querySelector(selector)?.getAttribute("content");
		if (value) return collapseWhitespace(value);
	}
	return undefined;
}

function cleanHtml(
	html: string,
	url: string,
): {
	title?: string;
	author?: string;
	publishedAt?: string;
	content: string;
} {
	const { document } = parseHTML(html);
	Object.assign(document, { URL: url, documentURI: url });
	const documentElement = document.documentElement as unknown as DomElement;
	sanitizeDocument(documentElement, url);
	const publishedAt =
		extractMetaContent(documentElement, [
			'meta[property="article:published_time"]',
			'meta[name="date"]',
			'meta[name="pubdate"]',
		]) ?? collapseWhitespace(document.querySelector("time[datetime]")?.getAttribute("datetime") ?? "");
	const author = extractMetaContent(documentElement, ['meta[name="author"]', 'meta[property="article:author"]']);
	const article = new Readability(
		document.cloneNode(true) as unknown as ConstructorParameters<typeof Readability>[0],
		{ charThreshold: 80, maxElemsToParse: 50_000 },
	).parse();
	const articleHtml = article?.content ?? document.body?.innerHTML ?? "";
	const articleDocument = parseHTML(`<html><body>${articleHtml}</body></html>`).document;
	const content = markdownChildren(articleDocument.body as unknown as DomElement, url)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const title = collapseWhitespace(article?.title ?? document.title ?? "");
	const resolvedAuthor = collapseWhitespace(article?.byline ?? author ?? "");
	const resolvedPublishedAt = collapseWhitespace(article?.publishedTime ?? publishedAt ?? "");
	return {
		...(title ? { title } : {}),
		...(resolvedAuthor ? { author: resolvedAuthor } : {}),
		...(resolvedPublishedAt ? { publishedAt: resolvedPublishedAt } : {}),
		content: content || collapseWhitespace(article?.textContent ?? document.body?.textContent ?? ""),
	};
}

function sanitizedHtml(html: string, url: string): { title?: string; content: string } {
	const { document } = parseHTML(html);
	const root = document.documentElement as unknown as DomElement;
	sanitizeDocument(root, url);
	const title = collapseWhitespace(document.title ?? "");
	return { ...(title ? { title } : {}), content: document.toString() };
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
	if (content.length <= maxChars) return { content, truncated: false };
	return { content: `${content.slice(0, maxChars).trimEnd()}\n\n[Content truncated]`, truncated: true };
}

function formatOutput(values: {
	url: string;
	title?: string;
	author?: string;
	publishedAt?: string;
	contentType: string;
	content: string;
	truncated: boolean;
}): string {
	return [
		`URL: ${values.url}`,
		values.title ? `Title: ${values.title}` : undefined,
		values.author ? `Author: ${values.author}` : undefined,
		values.publishedAt ? `Published: ${values.publishedAt}` : undefined,
		`Content-Type: ${values.contentType}`,
		values.truncated ? "Truncated: true" : undefined,
		"",
		values.content,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

export function createWebFetchTool(
	options: WebFetchToolOptions = {},
): AgentHarnessTool<undefined, typeof webFetchSchema, WebFetchToolDetails> {
	const requestFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
	const allowPrivateAddresses = options.allowPrivateAddresses ?? false;
	return {
		name: "web_fetch",
		label: "web_fetch",
		description: "Fetch an untrusted web page. Returns compact Markdown; clean=false returns sanitized HTML.",
		parameters: webFetchSchema,
		async execute(toolCallId, params, signal) {
			const resolved = { url: params.url, clean: params.clean ?? true };
			await recordWebToolCall(
				options.history,
				{
					schemaVersion: 1,
					toolCallId,
					tool: "web_fetch",
					timestamp: (options.now?.() ?? new Date()).toISOString(),
					suppliedArguments: structuredClone(params),
					resolvedArguments: structuredClone(resolved),
				},
				options.onHistoryError,
			);
			const initialUrl = normalizeHttpUrl(resolved.url);
			const requestSignal = createRequestSignal(signal, timeoutMs);
			try {
				const { response, finalUrl } = await fetchWithRedirects(requestFetch, initialUrl, {
					allowPrivateAddresses,
					maxRedirects,
					headers: options.headers ?? {},
					signal: requestSignal.signal,
				});
				if (!response.ok) throw new WebToolError("upstream_error", `Web fetch failed with HTTP ${response.status}`);
				const contentTypeHeader = response.headers.get("content-type") ?? "text/plain";
				const contentType = contentTypeHeader.split(";", 1)[0]?.trim().toLowerCase() ?? "text/plain";
				if (
					!contentType.startsWith("text/") &&
					!["application/xhtml+xml", "application/xml", "application/json"].includes(contentType)
				) {
					throw new WebToolError("unsupported_content_type", `Unsupported content type: ${contentType}`);
				}
				const bytes = await readResponse(response, maxResponseBytes);
				const source = decodeResponse(bytes, contentTypeHeader);
				const extracted = contentType.includes("html")
					? resolved.clean
						? cleanHtml(source, finalUrl.toString())
						: sanitizedHtml(source, finalUrl.toString())
					: { content: resolved.clean ? collapseWhitespace(source) : source };
				const truncated = truncateContent(extracted.content, maxContentChars);
				return {
					content: [
						{
							type: "text",
							text: formatOutput({
								url: finalUrl.toString(),
								...extracted,
								contentType,
								...truncated,
							}),
						},
					],
					details: {
						url: finalUrl.toString(),
						contentType,
						contentLength: truncated.content.length,
						truncated: truncated.truncated,
					},
				};
			} catch (cause) {
				if (cause instanceof WebToolError && cause.code !== "aborted") throw cause;
				if (requestSignal.signal.aborted) {
					if (requestSignal.timedOut()) {
						throw new WebToolError(
							"timeout",
							`Web fetch timed out after ${timeoutMs}ms`,
							cause instanceof Error ? cause : undefined,
						);
					}
					throw new WebToolError("aborted", "Web fetch aborted", cause instanceof Error ? cause : undefined);
				}
				throw cause;
			} finally {
				requestSignal.dispose();
			}
		},
	};
}

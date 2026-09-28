export type WebToolErrorCode =
	| "aborted"
	| "authentication"
	| "invalid_arguments"
	| "invalid_url"
	| "private_url"
	| "too_many_redirects"
	| "response_too_large"
	| "rate_limited"
	| "timeout"
	| "unsupported_content_type"
	| "upstream_error"
	| "invalid_response";

export class WebToolError extends Error {
	readonly code: WebToolErrorCode;

	constructor(code: WebToolErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WebToolError";
		this.code = code;
	}
}

export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function normalizeHttpUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch (cause) {
		throw new WebToolError("invalid_url", `Invalid URL: ${value}`, cause instanceof Error ? cause : undefined);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebToolError("invalid_url", `Unsupported URL protocol: ${url.protocol}`);
	}
	if (url.username || url.password) throw new WebToolError("invalid_url", "URLs with credentials are not allowed");
	return url;
}

export function canonicalizeWebUrl(value: string): string {
	const url = normalizeHttpUrl(value);
	url.hash = "";
	for (const key of [...url.searchParams.keys()]) {
		const normalized = key.toLowerCase();
		if (
			normalized.startsWith("utm_") ||
			["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "ref_src"].includes(normalized)
		) {
			url.searchParams.delete(key);
		}
	}
	return url.toString();
}

import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../src/markdown.ts";

test("renders markdown while escaping raw HTML and unsafe links", () => {
	const html = renderMarkdown(
		"## Result\n\n**done** [docs](https://example.com) [bad](javascript:alert(1)) [obfuscated](java%0ascript:alert(1)) [network path](//example.com)\n\n<script>alert(1)</script>",
	);

	assert.match(html, /<h2>Result<\/h2>/);
	assert.match(html, /<strong>done<\/strong>/);
	assert.match(html, /href="https:\/\/example\.com"/);
	assert.doesNotMatch(html, /javascript:/i);
	assert.doesNotMatch(html, /href="\/\/example\.com"/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("escapes fenced code and preserves its language class", () => {
	const html = renderMarkdown("```ts\nconst value = '<unsafe>';\n```");

	assert.match(html, /class="language-ts"/);
	assert.match(html, /data-markdown-copy/);
	assert.match(html, /hljs-keyword/);
	assert.match(html, /&lt;unsafe&gt;/);
	assert.doesNotMatch(html, /<unsafe>/);
});

test("falls back to escaped text for unknown languages", () => {
	const html = renderMarkdown("```not-a-language\n<b>&\n```");

	assert.match(html, /&lt;b&gt;&amp;/);
	assert.doesNotMatch(html, /<b>/);
});

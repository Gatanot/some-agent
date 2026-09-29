import { Marked } from "marked";
import { highlightCode } from "./highlight.ts";

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
}

function safeHref(href: string): boolean {
	const value = href.trim();
	if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value) || value.startsWith("#")) return true;
	if (/^[a-z][a-z\d+.-]*:/i.test(value) || /^[\\/]{2}/.test(value)) return false;
	return !/[\u0000-\u0020\u007f\\]/.test(value);
}

function languageClass(language: string | undefined): string {
	const value = language
		?.trim()
		.replace(/[^a-zA-Z0-9_-]/g, "")
		.slice(0, 40);
	return value ? ` class="language-${escapeHtml(value)}"` : "";
}

const markdown = new Marked({
	breaks: true,
	gfm: true,
	renderer: {
		code({ text, lang }) {
			const language = lang?.trim() ? escapeHtml(lang.trim().slice(0, 40)) : "Code";
			return `<div class="code-block markdown-code-block"><div class="code-head"><span>${language}</span><button class="tool-copy" type="button" data-markdown-copy aria-label="Copy code" title="Copy code">Copy</button></div><pre><code${languageClass(lang)}>${highlightCode(text, lang)}\n</code></pre></div>\n`;
		},
		html({ text }) {
			return escapeHtml(text);
		},
		image({ text }) {
			return `<span class="markdown-image">[image: ${escapeHtml(text)}]</span>`;
		},
		link({ href, title, text }) {
			if (!safeHref(href)) return `<span class="markdown-link">${escapeHtml(text)}</span>`;
			const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
			const external = /^https?:/i.test(href);
			const externalAttributes = external ? ' target="_blank" rel="noreferrer noopener"' : "";
			return `<a href="${escapeHtml(href)}"${titleAttribute}${externalAttributes}>${escapeHtml(text)}</a>`;
		},
	},
});

export function renderMarkdown(value: string): string {
	try {
		return markdown.parse(value) as string;
	} catch {
		return `<p>${escapeHtml(value)}</p>`;
	}
}

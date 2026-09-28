import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import css from "highlight.js/lib/languages/css.js";
import diff from "highlight.js/lib/languages/diff.js";
import go from "highlight.js/lib/languages/go.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import markdown from "highlight.js/lib/languages/markdown.js";
import python from "highlight.js/lib/languages/python.js";
import rust from "highlight.js/lib/languages/rust.js";
import sql from "highlight.js/lib/languages/sql.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import xml from "highlight.js/lib/languages/xml.js";
import yaml from "highlight.js/lib/languages/yaml.js";

const languages = {
	bash,
	c,
	cpp,
	css,
	diff,
	go,
	java,
	javascript,
	json,
	markdown,
	python,
	rust,
	sql,
	typescript,
	xml,
	yaml,
};

for (const [name, language] of Object.entries(languages)) {
	hljs.registerLanguage(name, language);
}

const aliases: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	ts: "typescript",
	tsx: "typescript",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	py: "python",
	yml: "yaml",
	html: "xml",
	md: "markdown",
	golang: "go",
	cxx: "cpp",
	h: "c",
};

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

/** Highlight a fenced code block. Returns escaped HTML, safe to inject. */
export function highlightCode(code: string, language: string | undefined): string {
	const name = language?.trim().toLowerCase();
	const resolved = name ? (aliases[name] ?? name) : undefined;
	if (resolved && hljs.getLanguage(resolved)) {
		try {
			return hljs.highlight(code, { language: resolved }).value;
		} catch {
			// Fall through to plain escaped text.
		}
	}
	return escapeHtml(code);
}

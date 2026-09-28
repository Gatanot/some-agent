import assert from "node:assert/strict";
import test from "node:test";
import { previewOutput } from "../src/truncate.ts";

test("keeps short text unchanged", () => {
	const preview = previewOutput("hello\nworld");

	assert.equal(preview.text, "hello\nworld");
	assert.equal(preview.truncated, false);
	assert.equal(preview.hiddenLines, 0);
	assert.equal(preview.hiddenChars, 0);
	assert.equal(preview.totalLines, 2);
});

test("keeps text at the line limit unchanged", () => {
	const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
	const preview = previewOutput(text);

	assert.equal(preview.truncated, false);
	assert.equal(preview.text, text);
});

test("truncates by line and reports hidden lines", () => {
	const text = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");
	const preview = previewOutput(text);

	assert.equal(preview.truncated, true);
	assert.equal(preview.totalLines, 50);
	assert.equal(preview.shownLines, 40);
	assert.equal(preview.hiddenLines, 10);
	assert.equal(preview.text, text.split("\n").slice(0, 40).join("\n"));
	assert.ok(text.startsWith(preview.text));
});

test("truncates a few very long lines by character budget", () => {
	const text = `start ${"x".repeat(9_000)}`;
	const preview = previewOutput(text);

	assert.equal(preview.truncated, true);
	assert.equal(preview.totalLines, 1);
	assert.equal(preview.shownLines, 1);
	assert.equal(preview.hiddenLines, 0);
	assert.equal(preview.hiddenChars, text.length - 8_000);
	assert.equal(preview.text.length, 8_000);
	assert.ok(text.startsWith(preview.text));
});

test("does not split a surrogate pair at the character budget", () => {
	const text = `${"x".repeat(7_999)}😀tail`;
	const preview = previewOutput(text);

	assert.equal(preview.truncated, true);
	assert.equal(preview.text, "x".repeat(7_999));
	assert.ok(!preview.text.includes("\uFFFD"));
	assert.ok(text.startsWith(preview.text));
});

test("handles empty text", () => {
	const preview = previewOutput("");

	assert.equal(preview.truncated, false);
	assert.equal(preview.text, "");
	assert.equal(preview.totalLines, 1);
});

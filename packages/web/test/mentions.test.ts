import assert from "node:assert/strict";
import test from "node:test";
import { applyMention, matchMention } from "../src/mentions.ts";

test("matches an unquoted mention at the caret", () => {
	const text = "review @src/lib";
	assert.deepEqual(matchMention(text, text.length), { start: 7, end: text.length, query: "src/lib", quoted: false });
});

test("matches a mention that starts at the beginning of the text", () => {
	const text = "@README";
	assert.deepEqual(matchMention(text, text.length), { start: 0, end: text.length, query: "README", quoted: false });
});

test("ignores an @ that is part of a word", () => {
	assert.equal(matchMention("user@example", "user@example".length), undefined);
	assert.equal(matchMention("hello world", 5), undefined);
});

test("matches a quoted mention containing spaces", () => {
	const text = 'open @"my docs/file';
	assert.deepEqual(matchMention(text, text.length), {
		start: 5,
		end: text.length,
		query: "my docs/file",
		quoted: true,
	});
});

test("replaces a plain mention and places the caret after a space", () => {
	const text = "check @src/l";
	const match = matchMention(text, text.length);
	assert.ok(match);
	const next = applyMention(text, match, "src/live.ts");
	assert.equal(next.text, "check @src/live.ts ");
	assert.equal(next.caret, next.text.length);
});

test("quotes a selected path that contains whitespace", () => {
	const text = "read @my";
	const match = matchMention(text, text.length);
	assert.ok(match);
	const next = applyMention(text, match, "my docs/file.ts");
	assert.equal(next.text, 'read @"my docs/file.ts" ');
	assert.equal(next.caret, next.text.length);
});

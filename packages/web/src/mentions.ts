/**
 * Parsing for `@path` file mentions typed into the composer. The functions are pure so the
 * textarea logic stays testable without a browser.
 */

export interface MentionMatch {
	/** Index of the `@` character. */
	start: number;
	/** Caret offset the match ends at (exclusive). */
	end: number;
	/** Text typed after `@`, without the optional surrounding quotes. */
	query: string;
	/** Whether the in-progress mention already opened a quote. */
	quoted: boolean;
}

/**
 * Finds the file mention that the caret is currently inside. A mention starts at an `@` that is
 * at the beginning of the text or preceded by whitespace and runs to the caret without an
 * intervening whitespace. `@"partial path` is accepted so paths with spaces can be completed.
 */
export function matchMention(text: string, caret: number): MentionMatch | undefined {
	const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));

	const quoted = /(?:^|\s)@"([^"]*)$/.exec(before);
	if (quoted) {
		const query = quoted[1] ?? "";
		const start = before.length - query.length - 2;
		return { start, end: before.length, query, quoted: true };
	}

	const plain = /(?:^|\s)@([^\s@"]*)$/.exec(before);
	if (!plain) return undefined;
	const query = plain[1] ?? "";
	const start = before.length - query.length - 1;
	return { start, end: before.length, query, quoted: false };
}

/** Replaces the mention at `match` with `@path` and returns the next text plus caret offset. */
export function applyMention(text: string, match: MentionMatch, path: string): { text: string; caret: number } {
	const token = /\s/.test(path) ? `@"${path}"` : `@${path}`;
	const nextText = `${text.slice(0, match.start)}${token} ${text.slice(match.end)}`;
	return { text: nextText, caret: match.start + token.length + 1 };
}

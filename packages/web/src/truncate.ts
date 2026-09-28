export interface OutputPreview {
	/** Prefix of the original text that should be rendered while collapsed. */
	text: string;
	truncated: boolean;
	totalLines: number;
	shownLines: number;
	hiddenLines: number;
	totalChars: number;
	hiddenChars: number;
}

export const OUTPUT_PREVIEW_LINES = 40;
export const OUTPUT_PREVIEW_CHARS = 8_000;

/** Slice without splitting a surrogate pair (a lone high surrogate would render as a replacement char). */
function sliceCodePoints(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	let end = maxChars;
	const code = value.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return value.slice(0, end);
}

/**
 * Compute the collapsed view of a long text block. Pure string work: the caller keeps the full
 * text for copying and only renders `text` until the user expands.
 */
export function previewOutput(
	text: string,
	maxLines: number = OUTPUT_PREVIEW_LINES,
	maxChars: number = OUTPUT_PREVIEW_CHARS,
): OutputPreview {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const totalChars = text.length;
	let preview = totalLines > maxLines ? lines.slice(0, maxLines).join("\n") : text;
	if (preview.length > maxChars) preview = sliceCodePoints(preview, maxChars);
	const truncated = preview.length < totalChars;
	const shownLines = preview.length === 0 ? 0 : preview.split("\n").length;
	return {
		text: preview,
		truncated,
		totalLines,
		shownLines,
		hiddenLines: truncated ? Math.max(0, totalLines - shownLines) : 0,
		totalChars,
		hiddenChars: truncated ? totalChars - preview.length : 0,
	};
}

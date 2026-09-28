import type { DiffLine } from "./types.ts";

const HEADER_PREFIXES = [
	"+++",
	"---",
	"diff ",
	"index ",
	"@@",
	"\\ No newline",
	"new file",
	"deleted file",
	"similarity",
	"rename ",
];

/** Parse a unified or display-oriented diff into colored lines. */
export function parseDiffLines(diff: string): DiffLine[] {
	const text = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
	return text.split("\n").map((line) => {
		if (HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) return { kind: "context" as const, text: line };
		if (line.startsWith("+")) return { kind: "add" as const, text: line.slice(1) };
		if (line.startsWith("-")) return { kind: "remove" as const, text: line.slice(1) };
		return { kind: "context" as const, text: line.startsWith(" ") ? line.slice(1) : line };
	});
}

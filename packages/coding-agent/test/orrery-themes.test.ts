import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAvailableThemes, loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

// The 51 required color tokens every theme must define (see theme-schema.json).
const REQUIRED_TOKENS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"selectedBg",
	"userMessageBg",
	"userMessageText",
	"customMessageBg",
	"customMessageText",
	"customMessageLabel",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
] as const;

const THEME_FILES = ["orrery-dark.json", "orrery-light.json"] as const;

interface ThemeJson {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
}

function readTheme(file: string): ThemeJson {
	return JSON.parse(
		readFileSync(new URL(`../src/modes/interactive/theme/${file}`, import.meta.url), "utf8"),
	) as ThemeJson;
}

function resolveColor(theme: ThemeJson, value: string | number, seen = new Set<string>()): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (seen.has(value)) {
		throw new Error(`Circular variable reference: ${value}`);
	}
	const resolved = theme.vars?.[value];
	if (resolved === undefined) {
		throw new Error(`Unknown variable reference: ${value}`);
	}
	return resolveColor(theme, resolved, new Set([...seen, value]));
}

function hexToRgb(hex: string): [number, number, number] {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
}

function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function asHex(theme: ThemeJson, token: string): string {
	const value = resolveColor(theme, theme.colors[token]);
	if (typeof value !== "string" || !value.startsWith("#")) {
		throw new Error(`Token ${token} must resolve to a hex color, got: ${String(value)}`);
	}
	return value;
}

// Text-on-background pairs that must stay readable; contrast targets follow WCAG
// (4.5:1 normal text, 3:1 large text / UI borders).
const CONTRAST_PAIRS: Array<{ fg: string; bg: string; min: number }> = [
	{ fg: "text", bg: "userMessageBg", min: 4.5 },
	{ fg: "text", bg: "customMessageBg", min: 4.5 },
	{ fg: "userMessageText", bg: "userMessageBg", min: 4.5 },
	{ fg: "customMessageText", bg: "customMessageBg", min: 4.5 },
	{ fg: "muted", bg: "userMessageBg", min: 4.5 },
	{ fg: "toolTitle", bg: "toolPendingBg", min: 4.5 },
	{ fg: "toolOutput", bg: "toolPendingBg", min: 4.5 },
	{ fg: "toolTitle", bg: "toolSuccessBg", min: 4.5 },
	{ fg: "toolTitle", bg: "toolErrorBg", min: 4.5 },
	{ fg: "toolDiffAdded", bg: "toolSuccessBg", min: 3 },
	{ fg: "toolDiffRemoved", bg: "toolErrorBg", min: 3 },
	{ fg: "accent", bg: "selectedBg", min: 3 },
	{ fg: "searchMatchText", bg: "searchMatchBg", min: 3 },
	{ fg: "mdHeading", bg: "userMessageBg", min: 3 },
	{ fg: "mdLink", bg: "userMessageBg", min: 3 },
	{ fg: "mdCode", bg: "userMessageBg", min: 3 },
	{ fg: "warning", bg: "userMessageBg", min: 3 },
	{ fg: "error", bg: "userMessageBg", min: 4.5 },
	{ fg: "success", bg: "userMessageBg", min: 3 },
];

describe("Orrery themes", () => {
	for (const file of THEME_FILES) {
		const theme = readTheme(file);

		it(`${file}: defines all 51 required color tokens`, () => {
			const missing = REQUIRED_TOKENS.filter((token) => !(token in theme.colors));
			expect(missing, `missing tokens: ${missing.join(", ")}`).toEqual([]);
		});

		it(`${file}: loads through the theme schema in truecolor and 256-color modes`, () => {
			const sourcePath = new URL(`../src/modes/interactive/theme/${file}`, import.meta.url).pathname;
			for (const mode of ["truecolor", "256color"] as const) {
				const loaded = loadThemeFromPath(sourcePath, mode);
				expect(loaded.name).toBe(theme.name);
				expect(loaded.getColorMode()).toBe(mode);
			}
		});

		it(`${file}: resolves every color token to a hex value without unknown or circular vars`, () => {
			for (const token of REQUIRED_TOKENS) {
				const value = resolveColor(theme, theme.colors[token]);
				expect(value, `${token} must resolve to a hex color`).toMatch(/^#[0-9a-f]{6}$/i);
			}
		});

		it(`${file}: keeps text and status colors readable on their backgrounds`, () => {
			for (const pair of CONTRAST_PAIRS) {
				const fg = asHex(theme, pair.fg);
				const bg = asHex(theme, pair.bg);
				const ratio = contrastRatio(fg, bg);
				expect(
					ratio,
					`${pair.fg} on ${pair.bg} must be >= ${pair.min}:1, got ${ratio.toFixed(2)}:1`,
				).toBeGreaterThanOrEqual(pair.min);
			}
		});

		it(`${file}: uses hex colors (no 256-color indices) so terminals can degrade via the core fallback`, () => {
			for (const [key, value] of Object.entries(theme.colors)) {
				expect(typeof value, `${key} must be a string or var reference`).toBe("string");
				const resolved = resolveColor(theme, value);
				expect(resolved, `${key} must be a hex color, got: ${String(resolved)}`).toMatch(/^#[0-9a-f]{6}$/i);
			}
		});
	}

	it("ships both Orrery themes as built-in themes", () => {
		const available = getAvailableThemes();
		expect(available).toContain("orrery-dark");
		expect(available).toContain("orrery-light");
	});
});

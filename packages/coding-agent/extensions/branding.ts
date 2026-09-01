/**
 * Orrery branded header/footer/status (roadmap 5.2).
 *
 * Bundled inside the @gatanot/orrery package (packages/coding-agent/extensions)
 * and auto-discovered by the extension loader, so `npm -g install @gatanot/orrery`
 * includes it without any extra setup.
 *
 * Replaces the built-in TUI header and footer with an Orrery-branded layout.
 * All colors come from active theme tokens and nothing is cached, so theme
 * hot-reload works through invalidate().
 *
 * Header (single line, no large art):
 *   ◈ Orrery v0.1.0   ~/repo   exts:2 skills:1 prompts:3 themes:2
 *
 * Footer (three lines on wide terminals):
 *   ~/repo (main) • session name
 *   ↑12k ↓3k $0.042 42.3%/200k        claude-sonnet-4-5 • high
 *   plan review checkpoint
 *
 * The third footer line is the status field: short statuses written by other
 * extensions via ctx.ui.setStatus() (plan, review, checkpoint, tests, ...).
 *
 * Layout tiers by terminal width (roadmap 6.1):
 *   <80   : statuses + branch + model only
 *   80+   : + session name, thinking level, context usage
 *   120+  : + cost, provider, header resource counts
 */

import { basename, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

let enabled = true;
let tui: TUI | undefined;
let resourceSummary = "";

function requestRender(): void {
	tui?.requestRender();
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolved = resolve(cwd);
	const resolvedHome = resolve(home);
	if (resolved === resolvedHome) return "~";
	if (resolved.startsWith(resolvedHome + sep)) {
		return `~${sep}${resolved.slice(resolvedHome.length + 1)}`;
	}
	return resolved;
}

function sanitizeStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Right-align `right` against `left` within `width`; truncates when they don't fit. */
function splitLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth + 2 <= width) {
		return truncateToWidth(left + " ".repeat(width - leftWidth - rightWidth) + right, width);
	}
	const available = width - leftWidth - 1;
	if (available <= 0) return truncateToWidth(left, width);
	const truncatedRight = truncateToWidth(right, available, "");
	return left + " ".repeat(Math.max(1, width - leftWidth - visibleWidth(truncatedRight))) + truncatedRight;
}

function countResources(pi: ExtensionAPI, ctx: ExtensionContext): string {
	try {
		const commands = pi.getCommands();
		const extensionPaths = new Set<string>();
		let skills = 0;
		let prompts = 0;
		for (const command of commands) {
			if (command.source === "extension") {
				extensionPaths.add(command.sourceInfo.path);
			} else if (command.source === "skill") {
				skills += 1;
			} else if (command.source === "prompt") {
				prompts += 1;
			}
		}
		const parts: string[] = [];
		if (extensionPaths.size > 0) parts.push(`exts:${extensionPaths.size}`);
		if (skills > 0) parts.push(`skills:${skills}`);
		if (prompts > 0) parts.push(`prompts:${prompts}`);
		const themeCount = ctx.ui.getAllThemes().length;
		if (themeCount > 0) parts.push(`themes:${themeCount}`);
		return parts.join(" ");
	} catch {
		// Resource counts are display-only; degrade to "not detected" when the
		// surrounding runtime does not expose the full API.
		return "";
	}
}

function renderHeader(ctx: ExtensionContext, theme: Theme, width: number): string[] {
	const brand = theme.fg("accent", "◈ Orrery") + theme.fg("dim", ` v${VERSION}`);
	const parts = [brand];
	if (width < 80) {
		parts.push(theme.fg("muted", basename(ctx.cwd)));
	} else {
		parts.push(theme.fg("muted", formatCwd(ctx.cwd)));
		if (width >= 120 && resourceSummary) parts.push(theme.fg("dim", resourceSummary));
	}
	return [truncateToWidth(parts.join("   "), width)];
}

function renderFooter(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
): string[] {
	const branch = footerData.getGitBranch();

	const statuses = Array.from(footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatus(text));

	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			input += message.usage.input;
			output += message.usage.output;
			cost += message.usage.cost.total;
		}
	}

	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = usage?.percent ?? null;
	const ctxDisplay =
		percent !== null
			? `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`
			: contextWindow > 0
				? `?/${formatTokens(contextWindow)}`
				: "?";
	const ctxStyled =
		percent !== null
			? percent > 90
				? theme.fg("error", ctxDisplay)
				: percent > 70
					? theme.fg("warning", ctxDisplay)
					: theme.fg("dim", ctxDisplay)
			: theme.fg("dim", ctxDisplay);

	const modelName = ctx.model?.id ?? "no-model";
	const thinking = ctx.model?.reasoning ? ` • ${ctx.thinkingLevel ?? "off"}` : "";
	const model = theme.fg("accent", modelName) + theme.fg("dim", thinking);
	const withProvider =
		footerData.getAvailableProviderCount() > 1 && ctx.model
			? theme.fg("dim", `(${ctx.model.provider}) `) + model
			: model;

	const sessionName = ctx.sessionManager.getSessionName();

	if (width < 80) {
		// Narrow: statuses, branch and model only.
		const location = [basename(ctx.cwd), branch ? `(${branch})` : null]
			.filter((part): part is string => part !== null)
			.join(" ");
		const lines: string[] = [];
		if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width));
		lines.push(splitLine(theme.fg("dim", location), withProvider, width));
		return lines;
	}

	const statsParts = [theme.fg("dim", `↑${formatTokens(input)}`), theme.fg("dim", `↓${formatTokens(output)}`)];
	if (width >= 120 && cost > 0) statsParts.push(theme.fg("dim", `$${cost.toFixed(3)}`));
	statsParts.push(ctxStyled);
	const statsLeft = statsParts.join(" ");

	const location = [formatCwd(ctx.cwd), branch ? `(${branch})` : null, sessionName ? `• ${sessionName}` : null]
		.filter((part): part is string => part !== null)
		.join(" ");

	const lines = [truncateToWidth(theme.fg("dim", location), width), splitLine(statsLeft, withProvider, width)];
	if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width));
	return lines;
}

export default function (pi: ExtensionAPI) {
	const installBranding = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader((tuiInstance, theme) => {
			tui = tuiInstance;
			return {
				invalidate() {},
				render(width: number): string[] {
					return renderHeader(ctx, theme, width);
				},
			};
		});

		ctx.ui.setFooter((tuiInstance, theme, footerData) => {
			tui = tuiInstance;
			const unsubscribe = footerData.onBranchChange(requestRender);
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					return renderFooter(ctx, theme, footerData, width);
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled) return;
		resourceSummary = countResources(pi, ctx);
		installBranding(ctx);
	});

	// Skills, prompts and themes are discovered after session_start; refresh the count then.
	pi.on("resources_discover", async (_event, ctx) => {
		resourceSummary = countResources(pi, ctx);
		requestRender();
	});

	pi.on("model_select", requestRender);
	pi.on("thinking_level_select", requestRender);

	pi.registerCommand("branding", {
		description: "Toggle the Orrery branded header and footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				installBranding(ctx);
				ctx.ui.notify("Orrery branding enabled", "info");
			} else {
				tui = undefined;
				ctx.ui.setHeader(undefined);
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default header and footer restored", "info");
			}
		},
	});
}

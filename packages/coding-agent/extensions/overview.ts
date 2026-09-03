import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const OVERVIEW_WIDTH = 76;

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function shortenPath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home || (path !== home && !path.startsWith(`${home}/`))) return path;
	return `~${path.slice(home.length)}`;
}

function valueOrFallback(value: string | undefined | null, fallback = "not detected"): string {
	return value && value.length > 0 ? value : fallback;
}

class OverviewComponent implements Component {
	private readonly theme: Theme;
	private readonly ctx: ExtensionCommandContext;
	private readonly done: () => void;
	private readonly branch: string | undefined;
	private readonly commandCount: number;
	private readonly activeToolCount: number;

	constructor(
		theme: Theme,
		ctx: ExtensionCommandContext,
		done: () => void,
		branch: string | undefined,
		commandCount: number,
		activeToolCount: number,
	) {
		this.theme = theme;
		this.ctx = ctx;
		this.done = done;
		this.branch = branch;
		this.commandCount = commandCount;
		this.activeToolCount = activeToolCount;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return")) this.done();
	}

	render(width: number): string[] {
		const outerWidth = Math.min(OVERVIEW_WIDTH, Math.max(40, width - 4));
		const innerWidth = outerWidth - 2;
		const border = this.theme.fg("border", "│");
		const line = (content = ""): string => {
			const padding = Math.max(0, innerWidth - visibleWidth(content));
			return `${border} ${truncateToWidth(content, innerWidth - 1)}${" ".repeat(padding)}${border}`;
		};
		const heading = (text: string): string => line(this.theme.fg("accent", text));
		const row = (label: string, value: string): string => line(`${this.theme.fg("dim", label.padEnd(15))}${value}`);

		const model = this.ctx.model;
		const usage = this.ctx.getContextUsage();
		const entries = this.ctx.sessionManager.getBranch();
		let userMessages = 0;
		let assistantMessages = 0;
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") userMessages++;
			if (entry.message.role === "assistant") assistantMessages++;
		}

		const context =
			usage && usage.percent !== null
				? `${usage.percent.toFixed(1)}% of ${formatTokens(usage.contextWindow)}`
				: "not available";
		const modelName = model ? `${model.provider}/${model.id}` : "not selected";
		const lines: string[] = [];

		lines.push(this.theme.fg("border", `╭${"─".repeat(outerWidth - 2)}╮`));
		lines.push(heading("Orrery Overview"));
		lines.push(line(this.theme.fg("dim", "Current runtime, session, context, and capabilities")));
		lines.push(line());
		lines.push(heading("Runtime"));
		lines.push(row("Mode", this.ctx.mode));
		lines.push(row("Working dir", shortenPath(this.ctx.cwd)));
		lines.push(row("Trust", this.ctx.isProjectTrusted() ? "project trusted" : "not trusted"));
		lines.push(line());
		lines.push(heading("Session"));
		lines.push(row("Name", valueOrFallback(this.ctx.sessionManager.getSessionName())));
		lines.push(row("State", this.ctx.isIdle() ? "idle" : "working"));
		lines.push(row("Messages", `${userMessages} user, ${assistantMessages} assistant`));
		lines.push(row("Pending", this.ctx.hasPendingMessages() ? "messages queued" : "none"));
		lines.push(line());
		lines.push(heading("Model"));
		lines.push(row("Current", modelName));
		lines.push(row("Thinking", this.ctx.thinkingLevel ?? "off"));
		lines.push(row("Context", context));
		lines.push(line());
		lines.push(heading("Capabilities"));
		lines.push(row("Tools", this.activeToolCount > 0 ? `${this.activeToolCount} active` : "none active"));
		lines.push(row("Commands", `${this.commandCount} available`));
		lines.push(row("Themes", `${this.ctx.ui.getAllThemes().length} available`));
		lines.push(row("Git", valueOrFallback(this.branch)));
		lines.push(row("UI", "interactive overlay"));
		lines.push(line());
		lines.push(line(this.theme.fg("dim", "Enter/Escape close")));
		lines.push(this.theme.fg("border", `╰${"─".repeat(outerWidth - 2)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("overview", {
		description: "Show the current Orrery runtime and session overview",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/overview is available in interactive mode", "info");
				return;
			}
			const branchResult = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: ctx.cwd });
			const branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
			const commandCount = pi.getCommands().length;
			const activeToolCount = pi.getActiveTools().length;
			await ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) =>
					new OverviewComponent(theme, ctx, done, branch, commandCount, activeToolCount),
				{ overlay: true },
			);
		},
	});
}

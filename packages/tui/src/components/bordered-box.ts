import type { Component } from "../tui.ts";
import { visibleWidth } from "../utils.ts";

/**
 * BorderedBox component - a container with padding and a colored border,
 * without a background fill. Renders rounded corners: ╭─╮ │ ╰─╯.
 *
 * Each rendered line is exactly `width` cells: border on both edges, content
 * in between. The border color function receives the whole line, so it must
 * only set foreground styling (child content keeps its own colors).
 */
export class BorderedBox implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private borderFn?: (text: string) => string;

	constructor(paddingX = 1, paddingY = 1, borderFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.borderFn = borderFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	setBorderFn(borderFn?: (text: string) => string): void {
		this.borderFn = borderFn;
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const innerWidth = Math.max(1, width - 2);
		const contentWidth = Math.max(1, innerWidth - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);
		const style = (line: string): string => (this.borderFn ? this.borderFn(line) : line);
		const edge = (inner: string): string => `│${inner}│`;

		const childLines: string[] = [];
		for (const child of this.children) {
			for (const line of child.render(contentWidth)) {
				childLines.push(leftPad + line);
			}
		}

		const lines: string[] = [];
		const horizontal = "─".repeat(Math.max(0, innerWidth));
		lines.push(style(`╭${horizontal}╮`));
		const paddingRow = edge(" ".repeat(innerWidth));
		for (let i = 0; i < this.paddingY; i++) {
			lines.push(style(paddingRow));
		}
		for (const line of childLines) {
			const padNeeded = Math.max(0, innerWidth - visibleWidth(line));
			lines.push(style(edge(line + " ".repeat(padNeeded))));
		}
		for (let i = 0; i < this.paddingY; i++) {
			lines.push(style(paddingRow));
		}
		lines.push(style(`╰${horizontal}╯`));
		return lines;
	}
}

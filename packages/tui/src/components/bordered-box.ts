import { type Component, dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "../tui.ts";
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
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	constructor(paddingX = 1, paddingY = 1, borderFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.borderFn = borderFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.mouseLayout = undefined;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.mouseLayout = undefined;
		}
	}

	clear(): void {
		this.children = [];
		this.mouseLayout = undefined;
	}

	setBorderFn(borderFn?: (text: string) => string): void {
		this.borderFn = borderFn;
	}

	invalidate(): void {
		this.mouseLayout = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const contentWidth = Math.max(1, event.width - 2 - this.paddingX * 2);
		const contentY = event.y - 1 - this.paddingY;
		const contentX = event.x - 1 - this.paddingX;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		const mouseChildren =
			this.mouseLayout?.width === contentWidth
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(contentWidth).length }));
		let childY = 0;
		for (const { component, height } of mouseChildren) {
			if (contentY >= childY && contentY < childY + height) {
				return dispatchMouseEvent(component, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height,
				});
			}
			childY += height;
		}
		return undefined;
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
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			mouseChildren.push({ component: child, height: lines.length });
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}
		this.mouseLayout = { width: contentWidth, children: mouseChildren };

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

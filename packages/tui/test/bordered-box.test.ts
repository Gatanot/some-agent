import assert from "node:assert";
import { describe, it } from "node:test";
import { BorderedBox } from "../src/components/bordered-box.ts";
import { Text } from "../src/components/text.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

describe("BorderedBox", () => {
	it("renders a rounded border with padding around content", () => {
		const box = new BorderedBox(1, 1);
		box.addChild(new Text("hi", 0, 0));

		assert.deepStrictEqual(plain(box.render(10)), [
			"╭────────╮",
			"│        │",
			"│ hi     │",
			"│        │",
			"╰────────╯",
		]);
	});

	it("renders nothing when it has no children", () => {
		const box = new BorderedBox(1, 1);
		assert.deepStrictEqual(box.render(10), []);
	});

	it("pads content lines to the exact width", () => {
		const box = new BorderedBox(0, 0);
		box.addChild(new Text("ab", 0, 0));

		const lines = box.render(6);
		for (const line of lines) {
			assert.strictEqual(stripTerminalSequences(line).length, 6);
		}
		assert.deepStrictEqual(plain(lines), ["╭────╮", "│ab  │", "╰────╯"]);
	});

	it("applies the border function to border and padding lines", () => {
		let calls = 0;
		const box = new BorderedBox(1, 0, (text: string) => {
			calls += 1;
			return `\x1b[31m${text}\x1b[39m`;
		});
		box.addChild(new Text("x", 0, 0));

		const lines = box.render(8);
		assert.ok(calls >= 3);
		for (const line of lines) {
			assert.match(line, /^\x1b\[31m/);
			assert.ok(line.endsWith("\x1b[39m"));
		}
		assert.deepStrictEqual(plain(lines), ["╭──────╮", "│ x    │", "╰──────╯"]);
	});

	it("updates children when invalidate is called", () => {
		const child = new Text("one", 0, 0);
		const box = new BorderedBox(0, 0);
		box.addChild(child);

		assert.deepStrictEqual(plain(box.render(8)), ["╭──────╮", "│one   │", "╰──────╯"]);

		child.setText("two");
		box.invalidate();
		assert.deepStrictEqual(plain(box.render(8)), ["╭──────╮", "│two   │", "╰──────╯"]);
	});
});

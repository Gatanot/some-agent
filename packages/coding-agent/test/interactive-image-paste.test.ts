import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard-image.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/clipboard-image.ts")>()),
	readClipboardImage: mocks.readClipboardImage,
}));
vi.mock("../src/utils/clipboard.ts", () => ({ copyToClipboard: vi.fn(), readClipboardText: mocks.readClipboardText }));

type PasteContext = {
	editor: { insertTextAtCursor: ReturnType<typeof vi.fn> };
	ui: { requestRender: ReturnType<typeof vi.fn> };
	session: { model: { input: string[] } | undefined };
	pendingImages: Map<number, { type: string; data: string; mimeType: string }>;
	pendingImageCounter: number;
	showStatus: ReturnType<typeof vi.fn>;
};

type PastePrototype = {
	handleClipboardPaste(this: PasteContext): Promise<void>;
	takePendingImages(
		this: PasteContext,
		text: string,
	): { text: string; images: { type: string; data: string; mimeType: string }[] };
};

// The methods under test call sibling private methods, so the fake `this` needs them as own properties.
const prototype = InteractiveMode.prototype as unknown as PastePrototype;
const siblingMethods = ["modelSupportsImages", "attachImage", "insertImagePath", "takePendingImages"] as const;

function createContext(supportsImages: boolean): PasteContext {
	const context = {
		editor: { insertTextAtCursor: vi.fn() },
		ui: { requestRender: vi.fn() },
		session: { model: { input: supportsImages ? ["text", "image"] : ["text"] } },
		pendingImages: new Map(),
		pendingImageCounter: 0,
		showStatus: vi.fn(),
	} as PasteContext & Record<string, unknown>;
	for (const name of siblingMethods) {
		context[name] = (InteractiveMode.prototype as unknown as Record<string, unknown>)[name];
	}
	return context;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.readClipboardText.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("clipboard image paste", () => {
	test("attaches the image and inserts a removable marker", async () => {
		const context = createContext(true);
		await prototype.handleClipboardPaste.call(context);

		expect(context.editor.insertTextAtCursor).toHaveBeenCalledWith("[image 1]");
		expect(context.pendingImages.size).toBe(1);
		expect(context.showStatus).not.toHaveBeenCalled();

		const { text, images } = prototype.takePendingImages.call(context, "look at this [image 1]");
		expect(text).toBe("look at this");
		expect(images).toHaveLength(1);
		expect(images[0].mimeType).toBe("image/png");
		expect(context.pendingImages.size).toBe(0);
	});

	test("drops an image whose marker was deleted before submit", async () => {
		const context = createContext(true);
		await prototype.handleClipboardPaste.call(context);

		const { text, images } = prototype.takePendingImages.call(context, "no marker here");
		expect(text).toBe("no marker here");
		expect(images).toHaveLength(0);
		expect(context.pendingImages.size).toBe(0);
	});

	test("falls back to a temp file path when the model does not support images", async () => {
		const context = createContext(false);
		await prototype.handleClipboardPaste.call(context);

		const inserted = context.editor.insertTextAtCursor.mock.calls[0][0] as string;
		expect(inserted).toMatch(/pi-clipboard-.*\.png$/);
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).toHaveBeenCalledWith(
			"Current model does not support images; inserted the file path instead",
		);

		try {
			fs.unlinkSync(inserted);
		} catch {
			// Best-effort cleanup.
		}
	});
});

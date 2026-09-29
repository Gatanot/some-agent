import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseFileLimit, searchProjectFiles } from "../src/files.ts";

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "orrery-web-files-"));
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
	await writeFile(join(root, "README.md"), "readme\n");
	await writeFile(join(root, "src", "live.ts"), "export {};\n");
	await writeFile(join(root, "src", "app.ts"), "export {};\n");
	await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
	return root;
}

test("ranks basename matches first and skips vendored directories", async () => {
	const root = await fixture();
	try {
		const files = await searchProjectFiles(root, "live", 20);
		assert.deepEqual(files, ["src/live.ts"]);

		const all = await searchProjectFiles(root, "", 20);
		assert.ok(all.includes("README.md"));
		assert.ok(!all.some((file) => file.includes("node_modules")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("parses file limits with a fallback", () => {
	assert.equal(parseFileLimit(null), 20);
	assert.equal(parseFileLimit("5"), 5);
	assert.equal(parseFileLimit("0"), 20);
	assert.equal(parseFileLimit("nope"), 20);
	assert.equal(parseFileLimit("9999"), 20);
});

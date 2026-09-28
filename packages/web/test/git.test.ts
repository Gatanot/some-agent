import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseGitStatus, parseNumstat, readGitDiff, readGitStatus } from "../src/git.ts";

test("parses NUL-delimited paths and rename records", () => {
	assert.deepEqual(parseGitStatus("R  new name.ts\0old name.ts\0?? 新文件.ts\0 M spaced name.ts\0"), [
		{ code: "R ", path: "new name.ts", previousPath: "old name.ts" },
		{ code: "??", path: "新文件.ts" },
		{ code: " M", path: "spaced name.ts" },
	]);
	assert.throws(() => parseGitStatus("R  orphan.ts\0"), /rename/);
});

test("parses numstat output into per-file line counts", () => {
	const stats = parseNumstat("3\t1\tsrc/a.ts\n-\t-\timage.png\n0\t0\t\n");
	assert.deepEqual(stats.get("src/a.ts"), { added: 3, removed: 1 });
	assert.deepEqual(stats.get("image.png"), { added: 0, removed: 0 });
});

test("reads repository-wide staged, unstaged, deleted, and untracked files", async () => {
	const root = await mkdtemp(join(tmpdir(), "orrery-git-test-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		await writeFile(join(root, "old name.ts"), "old\n");
		await writeFile(join(root, "tracked.txt"), "before\n");
		await writeFile(join(root, "deleted.txt"), "before\n");
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", [
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.org",
			"commit",
			"-qm",
			"base",
		]);
		await mkdir(join(root, "subdir"));
		execFileSync("git", ["-C", root, "mv", "old name.ts", "new name.ts"]);
		await writeFile(join(root, "tracked.txt"), "after\n");
		await unlink(join(root, "deleted.txt"));
		await writeFile(join(root, "新文件.ts"), "new\n");

		const result = await readGitStatus(join(root, "subdir"));
		assert.equal(result.state, "ready");
		assert.equal(result.root, root);
		assert.ok(result.branch);
		assert.ok(result.updatedAt);
		assert.deepEqual(
			result.files.find((file) => file.path === "new name.ts"),
			{
				code: "R ",
				path: "new name.ts",
				previousPath: "old name.ts",
			},
		);
		assert.equal(result.files.find((file) => file.path === "tracked.txt")?.code, " M");
		assert.deepEqual(
			result.files.find((file) => file.path === "tracked.txt"),
			{
				code: " M",
				path: "tracked.txt",
				added: 1,
				removed: 1,
			},
		);
		assert.equal(result.files.find((file) => file.path === "deleted.txt")?.code, " D");
		assert.equal(result.files.find((file) => file.path === "新文件.ts")?.code, "??");

		const trackedDiff = await readGitDiff(root, "tracked.txt", false);
		assert.match(trackedDiff.diff, /-before/);
		assert.match(trackedDiff.diff, /\+after/);
		assert.equal(trackedDiff.truncated, false);

		const untrackedDiff = await readGitDiff(root, "新文件.ts", true);
		assert.match(untrackedDiff.diff, /\+new/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports non-repositories without treating them as clean", async () => {
	const root = await mkdtemp(join(tmpdir(), "orrery-nongit-test-"));
	try {
		assert.deepEqual(await readGitStatus(root), { state: "unavailable", files: [] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

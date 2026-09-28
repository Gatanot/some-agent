import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WebGitFile, WebGitState } from "./protocol.ts";

const run = promisify(execFile);
const options = {
	encoding: "buffer" as const,
	timeout: 5_000,
	maxBuffer: 4 * 1024 * 1024,
	env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
};
const MAX_DIFF_BYTES = 256 * 1024;

export function parseNumstat(output: string): Map<string, { added: number; removed: number }> {
	const stats = new Map<string, { added: number; removed: number }>();
	for (const line of output.split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const path = parts.slice(2).join("\t");
		if (!path) continue;
		const added = Number.parseInt(parts[0] ?? "", 10);
		const removed = Number.parseInt(parts[1] ?? "", 10);
		stats.set(path, { added: Number.isNaN(added) ? 0 : added, removed: Number.isNaN(removed) ? 0 : removed });
	}
	return stats;
}

export function parseGitStatus(output: string): WebGitFile[] {
	const entries = output.split("\0");
	const files: WebGitFile[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry) continue;
		if (entry.length < 4 || entry[2] !== " ") throw new Error("Invalid Git status output");
		const code = entry.slice(0, 2);
		const path = entry.slice(3);
		if (!path) throw new Error("Invalid Git status path");
		const renamed = code.includes("R") || code.includes("C");
		const previousPath = renamed ? entries[++index] : undefined;
		if (renamed && !previousPath) throw new Error("Invalid Git rename output");
		files.push({ code, path, ...(previousPath ? { previousPath } : {}) });
	}
	return files;
}

export async function readGitStatus(cwd: string): Promise<WebGitState> {
	let root: string;
	try {
		const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], options);
		root = result.stdout.toString("utf8").trimEnd();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return /not a git repository/i.test(message)
			? { state: "unavailable", files: [] }
			: { state: "error", files: [], error: message };
	}
	try {
		const [status, branch, numstat] = await Promise.all([
			run("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], options),
			run("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], options).catch(() => undefined),
			run("git", ["-C", root, "diff", "HEAD", "--numstat"], options).catch(() => undefined),
		]);
		const stats = numstat
			? parseNumstat(numstat.stdout.toString("utf8"))
			: new Map<string, { added: number; removed: number }>();
		return {
			state: "ready",
			root,
			branch: branch?.stdout.toString("utf8").trimEnd() || "(detached HEAD)",
			files: parseGitStatus(status.stdout.toString("utf8")).map((file) => {
				const stat = stats.get(file.path);
				return stat ? { ...file, added: stat.added, removed: stat.removed } : file;
			}),
			updatedAt: new Date().toISOString(),
		};
	} catch (error) {
		return { state: "error", files: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Read the whole-workspace Git diff for one changed file (staged + unstaged relative to HEAD). */
export async function readGitDiff(
	root: string,
	filePath: string,
	untracked: boolean,
): Promise<{ diff: string; truncated: boolean }> {
	let diff = "";
	if (untracked) {
		// `git diff --no-index` exits non-zero when the files differ; the diff is on stdout.
		try {
			const result = await run(
				"git",
				["-C", root, "diff", "--no-index", "--no-color", "--", "/dev/null", filePath],
				options,
			);
			diff = result.stdout.toString("utf8");
		} catch (error) {
			const stdout = (error as { stdout?: Buffer }).stdout;
			diff = stdout ? stdout.toString("utf8") : "";
		}
	} else {
		try {
			const result = await run("git", ["-C", root, "diff", "HEAD", "--no-color", "--", filePath], options);
			diff = result.stdout.toString("utf8");
		} catch {
			const result = await run("git", ["-C", root, "diff", "--no-color", "--", filePath], options).catch(
				() => undefined,
			);
			diff = result ? result.stdout.toString("utf8") : "";
		}
	}
	if (Buffer.byteLength(diff) <= MAX_DIFF_BYTES) return { diff, truncated: false };
	return { diff: Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8"), truncated: true };
}

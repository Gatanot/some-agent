import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SCAN_ENTRIES = 20_000;
const CACHE_TTL_MS = 5_000;

const SKIP_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".cache",
	"__pycache__",
	".venv",
	"venv",
]);

interface FileCacheEntry {
	at: number;
	files: string[];
}

const cache = new Map<string, FileCacheEntry>();

export function parseFileLimit(value: string | null): number {
	if (!value) return DEFAULT_LIMIT;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) return DEFAULT_LIMIT;
	return parsed;
}

async function gitFiles(cwd: string): Promise<string[] | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd,
			maxBuffer: 16 * 1024 * 1024,
			windowsHide: true,
		});
		return stdout.split("\u0000").filter(Boolean);
	} catch {
		return undefined;
	}
}

async function walkFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	let scanned = 0;
	const pending = [root];
	while (pending.length > 0 && scanned < MAX_SCAN_ENTRIES) {
		const directory = pending.pop();
		if (directory === undefined) break;
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			scanned += 1;
			if (scanned > MAX_SCAN_ENTRIES) break;
			if (entry.isSymbolicLink()) continue;
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) pending.push(absolute);
				continue;
			}
			if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
		}
	}
	return files;
}

/** All project files under `cwd`, cached briefly so autocomplete does not respawn Git per keystroke. */
async function projectFiles(cwd: string): Promise<string[]> {
	const cached = cache.get(cwd);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.files;
	const files = (await gitFiles(cwd)) ?? (await walkFiles(cwd));
	cache.set(cwd, { at: Date.now(), files });
	return files;
}

function score(path: string, needle: string): number | undefined {
	const lower = path.toLowerCase();
	const at = lower.indexOf(needle);
	if (at < 0) return undefined;
	const base = lower.slice(lower.lastIndexOf("/") + 1);
	const baseAt = base.indexOf(needle);
	if (baseAt === 0) return base.length - needle.length;
	if (baseAt > 0) return 1_000 + baseAt;
	return 2_000 + at;
}

/** Ranks files by basename match, then path match, then shortness. */
export async function searchProjectFiles(cwd: string, rawQuery: string, limit: number): Promise<string[]> {
	const files = await projectFiles(cwd);
	const needle = rawQuery.trim().toLowerCase().replaceAll("\\", "/");
	if (!needle) return files.slice(0, limit);
	return files
		.map((path) => ({ path, score: score(path, needle) }))
		.filter((entry): entry is { path: string; score: number } => entry.score !== undefined)
		.sort((a, b) => a.score - b.score || a.path.length - b.path.length)
		.slice(0, limit)
		.map((entry) => entry.path);
}

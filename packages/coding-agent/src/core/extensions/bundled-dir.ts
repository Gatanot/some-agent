import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Find the extensions directory bundled inside the coding-agent package
 * (packages/coding-agent/extensions in source, <package-root>/extensions in
 * npm installs). Walks up from the caller location until it finds the package
 * manifest. Returns null in compiled-binary mode, where there is no
 * filesystem package layout.
 */
function findBundledExtensionsDir(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 10; i++) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
					name?: string;
					piConfig?: unknown;
				};
				if (pkg.piConfig || pkg.name === "@gatanot/orrery") {
					return path.join(dir, "extensions");
				}
			} catch {
				// Keep walking up.
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * Test hook: override the bundled extensions directory discovered inside the
 * @gatanot/orrery package. Pass `null` to disable bundled discovery, a
 * directory path to use it instead, or `undefined` to restore auto-discovery.
 */
let bundledExtensionsDirOverride: string | null | undefined;

export function setBundledExtensionsDirOverride(dir: string | null | undefined): void {
	bundledExtensionsDirOverride = dir;
}

export function getBundledExtensionsDir(): string | null {
	if (bundledExtensionsDirOverride !== undefined) return bundledExtensionsDirOverride;
	return findBundledExtensionsDir(path.dirname(fileURLToPath(import.meta.url)));
}

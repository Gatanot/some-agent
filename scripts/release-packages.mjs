import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function getPublicWorkspacePackages() {
	return findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}

// Packages in this scope are versioned and published by this fork. The vendored
// @earendil-works/pi-* packages track the upstream pi release they were synced
// from and are bundled into the published CLI, so they stay outside the fork's
// lockstep release set.
const RELEASE_SCOPE = "@gatanot/";

export function isReleasePackage(packageName) {
	return packageName.startsWith(RELEASE_SCOPE);
}

export function getReleaseWorkspacePackages() {
	return getPublicWorkspacePackages().filter((pkg) => isReleasePackage(pkg.name));
}

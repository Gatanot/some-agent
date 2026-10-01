import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function assertPublishedDependenciesMatch(name, version, local, published, packages) {
	for (const pkg of packages) {
		if (pkg.name === name) continue;
		if (local[pkg.name] !== published[pkg.name]) {
			throw new Error(
				`${name}@${version} is already published with different dependencies (${pkg.name}). ` +
				"Bump the release version before publishing renamed packages.",
			);
		}
	}
}

export function getPublicWorkspacePackages() {
	const packages = findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true);
	const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
	if (byName.size !== packages.length) throw new Error("Duplicate public package names");
	for (const pkg of packages) {
		for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
			if (name.startsWith("@earendil-works/pi-") || name === "@earendil-works/chord") {
				throw new Error(`${pkg.name} still depends on upstream package ${name}`);
			}
			const dependency = byName.get(name);
			if (dependency && range !== `^${dependency.version}` && range !== dependency.version) {
				throw new Error(`${pkg.name} depends on ${name}@${range}; expected ${dependency.version}`);
			}
		}
	}
	const ordered = [];
	const visiting = new Set();
	const visited = new Set();

	function visit(pkg) {
		if (visiting.has(pkg.name)) throw new Error(`Circular package dependency: ${pkg.name}`);
		if (visited.has(pkg.name)) return;
		visiting.add(pkg.name);
		for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
			const dependency = byName.get(name);
			if (dependency) visit(dependency);
		}
		visiting.delete(pkg.name);
		visited.add(pkg.name);
		ordered.push({ directory: pkg.directory, name: pkg.name, version: pkg.version });
	}

	for (const pkg of packages) visit(pkg);
	return ordered;
}

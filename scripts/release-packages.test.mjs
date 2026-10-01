import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublishedDependenciesMatch, getPublicWorkspacePackages } from "./release-packages.mjs";

test("public packages publish after their workspace dependencies", () => {
	const packages = getPublicWorkspacePackages();
	const positions = new Map(packages.map((pkg, index) => [pkg.name, index]));
	assert.equal(positions.size, packages.length);
	assert.equal(new Set(packages.map((pkg) => pkg.version)).size, 1);
	for (const pkg of packages) {
		const manifest = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
			if (positions.has(dependency)) {
				assert.ok(positions.get(dependency) < positions.get(pkg.name), `${dependency} must precede ${pkg.name}`);
			}
		}
	}
});

test("published package with old internal dependencies cannot be reused", () => {
	const packages = [{ name: "@gatanot/orrery" }, { name: "@gatanot/orrery-ai" }];
	assert.doesNotThrow(() => assertPublishedDependenciesMatch(
		"@gatanot/orrery", "0.2.6", { "@gatanot/orrery-ai": "^0.2.6" },
		{ "@gatanot/orrery-ai": "^0.2.6" }, packages,
	));
	assert.throws(() => assertPublishedDependenciesMatch(
		"@gatanot/orrery", "0.2.5", { "@gatanot/orrery-ai": "^0.2.5" },
		{ "@earendil-works/pi-ai": "^0.87.1" }, packages,
	), /Bump the release version/);
});

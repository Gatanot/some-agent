#!/usr/bin/env node

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const repoRoot = resolve(import.meta.dirname, "..");
const webDir = join(repoRoot, "packages", "web");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const outputDir = join(codingAgentDir, "dist", "web");
const assetsDir = join(codingAgentDir, "dist", "web-ui");

rmSync(outputDir, { force: true, recursive: true });
rmSync(assetsDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });

await build({
	absWorkingDir: repoRoot,
	bundle: true,
	entryPoints: [join(webDir, "src", "server.ts")],
	platform: "node",
	format: "esm",
	outfile: join(outputDir, "server.js"),
	target: "node22.19",
	external: ["@gatanot/orrery"],
	banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

cpSync(join(webDir, "dist"), assetsDir, { recursive: true });
console.log("Built packages/coding-agent/dist/web and dist/web-ui");

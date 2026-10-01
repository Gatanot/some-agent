import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordBundler: fileURLToPath(new URL("./packages/chord/src/bundler.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent/src/node.ts", import.meta.url)),
	protocolIndex: fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
	clientIndex: fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
	clientUnix: fileURLToPath(new URL("./packages/client/src/unix.ts", import.meta.url)),
	serverIndex: fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
	serverUnix: fileURLToPath(new URL("./packages/server/src/transports/unix/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@gatanot\/orrery-chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@gatanot\/orrery-chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@gatanot\/orrery-chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@gatanot\/orrery-chord\/bundler$/, replacement: workspaceSourcePaths.chordBundler },
			{ find: /^@gatanot\/orrery-chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@gatanot\/orrery-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@gatanot\/orrery-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@gatanot\/orrery-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@gatanot\/orrery-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@gatanot\/orrery-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@gatanot\/orrery-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@gatanot\/orrery-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@gatanot\/orrery-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@gatanot\/orrery-agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{ find: /^@gatanot\/orrery-protocol$/, replacement: workspaceSourcePaths.protocolIndex },
			{ find: /^@gatanot\/orrery-client$/, replacement: workspaceSourcePaths.clientIndex },
			{ find: /^@gatanot\/orrery-client\/unix$/, replacement: workspaceSourcePaths.clientUnix },
			{ find: /^@gatanot\/orrery-server$/, replacement: workspaceSourcePaths.serverIndex },
			{ find: /^@gatanot\/orrery-server\/unix$/, replacement: workspaceSourcePaths.serverUnix },
			{ find: /^@gatanot\/orrery-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});

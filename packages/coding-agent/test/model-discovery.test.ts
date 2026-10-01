import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { supportsOpenAICompatibleDiscovery } from "../src/core/model-discovery.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

interface DiscoveryFixture {
	tempDir: string;
	modelsPath: string;
	storePath: string;
	providerId: string;
	writeModelsJson(): void;
}

function createFixture(provider: Record<string, unknown>): DiscoveryFixture {
	const tempDir = join(tmpdir(), `pi-test-model-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const modelsPath = join(tempDir, "models.json");
	const storePath = join(tempDir, "models-store.json");
	const providerId = "relay";
	return {
		tempDir,
		modelsPath,
		storePath,
		providerId,
		writeModelsJson() {
			writeFileSync(modelsPath, JSON.stringify({ providers: { relay: provider } }));
		},
	};
}

describe("models.json provider discovery", () => {
	let fixture: DiscoveryFixture | undefined;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		if (fixture && existsSync(fixture.tempDir)) rmSync(fixture.tempDir, { recursive: true });
		fixture = undefined;
		vi.restoreAllMocks();
	});

	it("detects discoverable OpenAI-compatible providers only", () => {
		expect(supportsOpenAICompatibleDiscovery({ baseUrl: "https://relay.test/v1", api: "openai-completions" })).toBe(
			true,
		);
		expect(
			supportsOpenAICompatibleDiscovery({
				baseUrl: "https://relay.test/v1",
				models: [{ id: "m", api: "openai-responses" }],
			}),
		).toBe(true);
		expect(supportsOpenAICompatibleDiscovery({ baseUrl: "https://relay.test", api: "anthropic-messages" })).toBe(
			false,
		);
		expect(supportsOpenAICompatibleDiscovery({ api: "openai-completions" })).toBe(false);
		expect(supportsOpenAICompatibleDiscovery(undefined)).toBe(false);
	});

	it("fetches, parses, and persists the provider model list", async () => {
		fixture = createFixture({
			name: "Relay",
			baseUrl: "https://relay.test/v1",
			api: "openai-completions",
			apiKey: "relay-key",
		});
		fixture.writeModelsJson();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "plain-model", object: "model" },
						{
							id: "vision-reasoner",
							display_name: "Vision Reasoner",
							capabilities: {
								vision: true,
								input_modalities: ["text", "image"],
								reasoning: { effort_values: ["none", "low", "high"], default: "high" },
							},
						},
						{ id: "plain-model", object: "model" },
						"string-model",
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: fixture.modelsPath,
			modelsStorePath: fixture.storePath,
			allowModelNetwork: false,
		});
		const result = await runtime.refresh({ providers: [fixture.providerId], force: true, allowNetwork: true });
		expect(result.errors.size).toBe(0);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://relay.test/v1/models");
		expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)?.authorization).toBe("Bearer relay-key");

		const models = runtime.getModels(fixture.providerId);
		expect(models.map((model) => model.id).sort()).toEqual(["plain-model", "string-model", "vision-reasoner"]);
		const vision = models.find((model) => model.id === "vision-reasoner");
		expect(vision).toMatchObject({
			name: "Vision Reasoner",
			provider: "relay",
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 16384,
		});
		expect(vision?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(runtime.getAvailableSnapshot().map((model) => model.id)).toContain("vision-reasoner");

		// A fresh runtime restores the persisted catalog without network access.
		vi.restoreAllMocks();
		const restoredFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
		const restored = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: fixture.modelsPath,
			modelsStorePath: fixture.storePath,
			allowModelNetwork: false,
		});
		expect(
			restored
				.getModels(fixture.providerId)
				.map((model) => model.id)
				.sort(),
		).toEqual(["plain-model", "string-model", "vision-reasoner"]);
		expect(restoredFetch).not.toHaveBeenCalled();
	});

	it("keeps the previous catalog and reports refresh failures", async () => {
		fixture = createFixture({
			baseUrl: "https://relay.test/v1",
			api: "openai-completions",
			apiKey: "relay-key",
			models: [{ id: "configured-model" }],
		});
		fixture.writeModelsJson();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: fixture.modelsPath,
			modelsStorePath: fixture.storePath,
			allowModelNetwork: false,
		});
		const result = await runtime.refresh({ providers: [fixture.providerId], force: true, allowNetwork: true });
		expect(result.errors.get("relay")?.message).toMatch(/401/);
		expect(runtime.getModels(fixture.providerId).map((model) => model.id)).toEqual(["configured-model"]);
	});
});

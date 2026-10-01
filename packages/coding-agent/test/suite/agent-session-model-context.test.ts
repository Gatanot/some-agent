import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("agent session model context window overrides", () => {
	it("applies settings overrides on startup, model switch, and refresh", async () => {
		const harness = await createHarness({
			models: [
				{ id: "model-a", name: "Model A", contextWindow: 1000, maxTokens: 100 },
				{ id: "model-b", name: "Model B", contextWindow: 2000, maxTokens: 100 },
			],
			settings: { modelContextWindows: { "faux/model-a": 5000 } },
		});
		try {
			expect(harness.session.model?.id).toBe("model-a");
			expect(harness.session.model?.contextWindow).toBe(5000);

			const modelB = harness.getModel("model-b");
			expect(modelB).toBeDefined();
			await harness.session.setModel(modelB!);
			expect(harness.session.model?.id).toBe("model-b");
			expect(harness.session.model?.contextWindow).toBe(2000);

			harness.settingsManager.setModelContextWindow("faux", "model-b", 9000);
			harness.session.refreshModelOverrides();
			expect(harness.session.model?.contextWindow).toBe(9000);

			harness.settingsManager.removeModelContextWindow("faux", "model-b");
			harness.session.refreshModelOverrides();
			expect(harness.session.model?.contextWindow).toBe(2000);

			// The settings object held by the session keeps the override for future switches.
			await harness.session.setModel(harness.getModel("model-a")!);
			expect(harness.session.model?.contextWindow).toBe(5000);
		} finally {
			harness.cleanup();
		}
	});
});

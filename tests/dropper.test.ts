import { describe, expect, it } from "vitest";

import { normalizeDropObservationIds, runDropper } from "../src/agents/dropper/agent.js";
import { observation, reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

describe("V3 dropper agent", () => {
	const obsA = observation("aaaaaaaaaaaa", { relevance: "medium" });
	const obsB = observation("bbbbbbbbbbbb", { relevance: "low" });
	const critical = observation("cccccccccccc", { relevance: "critical" });
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		observations: [obsA, obsB, critical],
		budgetTokens: 10,
	};

	it("keeps core dropper safety guidance in V3 terms", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.systemPrompt;
		});

		await runDropper({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Active-memory framing");
		expect(systemPrompt).toContain("Age-gradient rule");
		expect(systemPrompt).toContain("critical");
		expect(systemPrompt).toContain("NEVER drop");
		expect(systemPrompt).toContain("User assertions and concrete completions are never droppable");
		expect(systemPrompt).toContain("Preservation floor");
		expect(systemPrompt).toContain("Do not force drops");
		expect(systemPrompt).toContain("You cannot merge observations");
		expect(systemPrompt).not.toContain("pruner");
		expect(systemPrompt).not.toContain("[coverage:");
		expect(systemPrompt).not.toContain("Pass strategy");
	});

	it("normalizes active drop ids, filters invalid ids, dedupes, and protects critical observations", () => {
		expect(normalizeDropObservationIds(["bbbbbbbbbbbb", "missing", "bbbbbbbbbbbb", "cccccccccccc", "aaaaaaaaaaaa"], [obsA, obsB, critical])).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
		expect(normalizeDropObservationIds(["missing", "cccccccccccc"], [obsA, obsB, critical])).toBeUndefined();
	});

	it("returns dropped active observation ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["bbbbbbbbbbbb", "missing", "aaaaaaaaaaaa"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
	});

	it("returns undefined when only invalid or protected ids are proposed", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["missing", "cccccccccccc"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes repeated tool calls", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["bbbbbbbbbbbb"] });
			await context.tools[0].execute("tool-2", { ids: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
	});

	it("returns undefined when no tool call drops observations", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";

import {
	maxDropCountForPool,
	normalizeDropObservationIds,
	observationPoolFullness,
	runDropper,
	selectDropCandidates,
} from "../src/agents/dropper/agent.js";
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
		targetTokens: 20,
	};

	it("computes observation pool fullness defensively", () => {
		expect(observationPoolFullness(0, 100)).toBe(0);
		expect(observationPoolFullness(-1, 100)).toBe(0);
		expect(observationPoolFullness(10, 0)).toBe(0);
		expect(observationPoolFullness(10, Number.NaN)).toBe(0);
		expect(observationPoolFullness(25, 100)).toBe(0.25);
	});

	it("computes max drops from token excess above target", () => {
		const observations = Array.from({ length: 10 }, (_, index) =>
			observation(`${index}`.padStart(12, "a"), { relevance: "low", tokenCount: 10 }),
		);

		expect(maxDropCountForPool(observations, 100, 100)).toBe(0);
		expect(maxDropCountForPool(observations, 100, 90)).toBe(1);
		expect(maxDropCountForPool(observations, 100, 50)).toBe(5);
		expect(maxDropCountForPool(observations, 100, 0)).toBe(10);
	});

	it("uses active observation count for target-return max drops while critical ids remain protected later", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 10 }),
			observation("bbbbbbbbbbbb", { relevance: "medium", tokenCount: 10 }),
			observation("cccccccccccc", { relevance: "critical", tokenCount: 10 }),
			observation("dddddddddddd", { relevance: "critical", tokenCount: 10 }),
		];

		expect(maxDropCountForPool(observations, 40, 20)).toBe(2);
	});

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
		expect(systemPrompt).toContain("Default action is KEEP");
		expect(systemPrompt).toContain("When uncertain, keep");
		expect(systemPrompt).toContain("active observation pool target");
		expect(systemPrompt).not.toContain("drop freely");
		expect(systemPrompt).not.toContain("pruner");
		expect(systemPrompt).not.toContain("[coverage:");
		expect(systemPrompt).not.toContain("Pass strategy");
		expect(systemPrompt).not.toContain("Urgency guidance");
	});

	it("passes target-return max drops as a hard upper bound", async () => {
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runDropper({ ...baseArgs, agentLoop: loop });

		expect(userText).toContain("fullness against target: ~150%");
		expect(userText).toContain("over target by ~10 tokens");
		expect(userText).toContain("Maximum drops allowed this run: 1 observation");
		expect(userText).toContain("sized to move the active pool toward the target");
		expect(userText).toContain("hard upper bound, not a target");
		expect(userText).toContain("Drop fewer or none");
		expect(userText).not.toContain("Drop urgency");
	});

	it("normalizes active drop ids, filters invalid ids, dedupes, and protects critical observations", () => {
		expect(normalizeDropObservationIds(["bbbbbbbbbbbb", "missing", "bbbbbbbbbbbb", "cccccccccccc", "aaaaaaaaaaaa"], [obsA, obsB, critical])).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
		expect(normalizeDropObservationIds(["missing", "cccccccccccc"], [obsA, obsB, critical])).toBeUndefined();
	});

	it("selects final candidates by lower relevance first with stable ordering", () => {
		const highA = observation("aaaaaaaaaaaa", { relevance: "high" });
		const lowA = observation("bbbbbbbbbbbb", { relevance: "low" });
		const medium = observation("dddddddddddd", { relevance: "medium" });
		const lowB = observation("eeeeeeeeeeee", { relevance: "low" });
		const highB = observation("ffffffffffff", { relevance: "high" });
		const critical = observation("111111111111", { relevance: "critical" });
		const observations = [highA, lowA, medium, lowB, highB, critical];

		expect(selectDropCandidates([
			"aaaaaaaaaaaa",
			"missing",
			"111111111111",
			"bbbbbbbbbbbb",
			"dddddddddddd",
			"bbbbbbbbbbbb",
			"eeeeeeeeeeee",
			"ffffffffffff",
		], observations, 3)).toEqual(["bbbbbbbbbbbb", "eeeeeeeeeeee", "dddddddddddd"]);
	});

	it("returns capped lower-relevance proposed observation ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["aaaaaaaaaaaa", "missing", "bbbbbbbbbbbb"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["bbbbbbbbbbbb"]);
	});

	it("returns undefined when only invalid or protected ids are proposed", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["missing", "cccccccccccc"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes repeated tool calls and enforces one run-level cap", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { ids: ["aaaaaaaaaaaa"] });
			await context.tools[0].execute("tool-2", { ids: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] });
		});

		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toEqual(["bbbbbbbbbbbb"]);
	});

	it("returns undefined when no tool call drops observations", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runDropper({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("skips the model at or below the target", async () => {
		let called = false;
		const loop = fakeAgentLoop(() => {
			called = true;
		});

		await expect(runDropper({
			...baseArgs,
			observations: [observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 10 })],
			targetTokens: 10,
			agentLoop: loop,
		})).resolves.toBeUndefined();
		expect(called).toBe(false);
	});
});

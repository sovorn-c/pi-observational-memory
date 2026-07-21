import { describe, expect, it } from "vitest";

import { runReflectionDigest } from "../src/agents/reflection-digest.js";
import { reflection } from "./fixtures/session.js";

function fakeAgentLoop(
	handler: (prompts: any[], context: any, config: any, signal?: AbortSignal) => Promise<void> | void,
): any {
	return ((prompts: any[], context: any, config: any, signal?: AbortSignal) => ({
		async *[Symbol.asyncIterator]() {
			// No streaming events needed for these tests.
		},
		result: async () => {
			await handler(prompts, context, config, signal);
			return {};
		},
	})) as any;
}

describe("runReflectionDigest", () => {
	it("records the digest in one terminating tool turn and forwards cancellation", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		let seenReasoning: unknown;
		let toolResult: unknown;
		const loop = fakeAgentLoop(async (_prompts, context, config, signal) => {
			seenSignal = signal;
			seenReasoning = config.reasoning;
			toolResult = await context.tools[0].execute("tool-1", { content: "Compact durable facts." });
		});

		const result = await runReflectionDigest({
			model: { reasoning: true, maxTokens: 10_000 } as any,
			apiKey: "test",
			olderReflections: [reflection("aaaaaaaaaaaa", ["111111111111"])],
			maxTokens: 1_000,
			signal: controller.signal,
			agentLoop: loop,
		});

		expect(result).toBe("Compact durable facts.");
		expect(seenSignal).toBe(controller.signal);
		expect(seenReasoning).toBe("low");
		expect(toolResult).toMatchObject({ terminate: true });
	});

	it("allows reasoning to be disabled explicitly", async () => {
		let seenReasoning: unknown = "unset";
		const loop = fakeAgentLoop(async (_prompts, context, config) => {
			seenReasoning = config.reasoning;
			await context.tools[0].execute("tool-1", { content: "Digest." });
		});

		await runReflectionDigest({
			model: { reasoning: true, maxTokens: 10_000 } as any,
			apiKey: "test",
			olderReflections: [reflection("aaaaaaaaaaaa", ["111111111111"])],
			maxTokens: 1_000,
			thinkingLevel: "off",
			agentLoop: loop,
		});

		expect(seenReasoning).toBeUndefined();
	});
});

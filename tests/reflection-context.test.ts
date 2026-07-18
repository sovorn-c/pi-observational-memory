import { describe, expect, it } from "vitest";

import {
	REFLECTION_DIGEST_RATIO,
	REFLECTION_RECENT_RATIO,
	reflectionContextBudget,
	selectRecentReflections,
} from "../src/reflection-context.js";
import { reflection } from "./fixtures/session.js";

describe("reflection context budget", () => {
	it("splits one public budget into integer digest and recent allocations", () => {
		expect(REFLECTION_DIGEST_RATIO + REFLECTION_RECENT_RATIO).toBe(1);
		expect(reflectionContextBudget(10_000)).toEqual({
			totalTokens: 10_000,
			digestTokens: 4_000,
			recentTokens: 6_000,
		});
		expect(reflectionContextBudget(9_999).digestTokens + reflectionContextBudget(9_999).recentTokens).toBe(9_999);
	});

	it("keeps the newest chronological suffix and returns the older prefix", () => {
		const reflections = [
			reflection("aaaaaaaaaaaa", [], { tokenCount: 2 }),
			reflection("bbbbbbbbbbbb", [], { tokenCount: 3 }),
			reflection("cccccccccccc", [], { tokenCount: 4 }),
			reflection("dddddddddddd", [], { tokenCount: 5 }),
		];

		const result = selectRecentReflections(reflections, 9);
		expect(result.recent.map((item) => item.id)).toEqual(["cccccccccccc", "dddddddddddd"]);
		expect(result.older.map((item) => item.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
	});
});

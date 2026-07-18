import type { Reflection, ReflectionDigest } from "./session-ledger/index.js";
import { estimateStringTokens } from "./tokens.js";

/** Internal split agreed for the single public reflection-context budget. */
export const REFLECTION_DIGEST_RATIO = 0.4;
export const REFLECTION_RECENT_RATIO = 0.6;

export type ReflectionContextBudget = {
	totalTokens: number;
	digestTokens: number;
	recentTokens: number;
};

export type ReflectionContextSelection = {
	recent: Reflection[];
	older: Reflection[];
	digest?: ReflectionDigest;
	budget: ReflectionContextBudget;
};

export function reflectionContextBudget(totalTokens: number): ReflectionContextBudget {
	const total = Math.max(1, Math.floor(totalTokens));
	const digestTokens = Math.floor(total * REFLECTION_DIGEST_RATIO);
	return { totalTokens: total, digestTokens, recentTokens: total - digestTokens };
}

/** Select the newest chronological suffix that fits the recent allocation. */
export function selectRecentReflections(reflections: readonly Reflection[], maxTokens: number): {
	recent: Reflection[];
	older: Reflection[];
} {
	const recent: Reflection[] = [];
	let tokens = 0;
	for (let i = reflections.length - 1; i >= 0; i--) {
		const reflection = reflections[i];
		if (recent.length > 0 && tokens + reflection.tokenCount > maxTokens) break;
		if (recent.length === 0 && reflection.tokenCount > maxTokens) {
			// Always retain the newest reflection, even if it is unusually large.
			recent.unshift(reflection);
			tokens += reflection.tokenCount;
			break;
		}
		recent.unshift(reflection);
		tokens += reflection.tokenCount;
	}
	const recentIds = new Set(recent.map((reflection) => reflection.id));
	return { recent, older: reflections.filter((reflection) => !recentIds.has(reflection.id)) };
}

export function digestTokenCount(content: string): number {
	return estimateStringTokens(content);
}

export function digestFitsBudget(digest: ReflectionDigest | undefined, budget: ReflectionContextBudget): boolean {
	return !digest || digest.tokenCount <= budget.digestTokens;
}

export function reflectionDigestLine(digest: ReflectionDigest): string {
	return digest.content;
}

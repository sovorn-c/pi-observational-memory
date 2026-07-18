import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runReflectionDigest } from "../agents/reflection-digest.js";
import {
	digestTokenCount,
	reflectionContextBudget,
	selectRecentReflections,
} from "../reflection-context.js";
import type { Runtime } from "../runtime.js";
import { buildCompactionProjection, renderSummary, type Entry, type Reflection, type ReflectionDigest } from "../session-ledger/index.js";
import { reflectionToSummaryLine } from "../session-ledger/render-summary.js";
import { estimateStringTokens } from "../tokens.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;
const DEFAULT_REFLECTION_CONTEXT_MAX_TOKENS = 10_000;

function reflectionContextMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { reflectionContextMaxTokens?: unknown }).reflectionContextMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_REFLECTION_CONTEXT_MAX_TOKENS;
}

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

function fallbackDigestContent(previous: ReflectionDigest | undefined, older: Reflection[], maxTokens: number): string {
	const source = [
		...(previous ? [previous.content] : []),
		...older.map(reflectionToSummaryLine),
	].join("\n");
	const maxChars = Math.max(4, Math.floor(maxTokens * 4));
	if (estimateStringTokens(source) <= maxTokens) return source;
	let result = `${source.slice(0, Math.max(1, maxChars - 24))} … [digest truncated]`;
	while (estimateStringTokens(result) > maxTokens && result.length > 1) result = result.slice(0, -1);
	return result;
}

async function buildReflectionContext(projection: ReturnType<typeof buildCompactionProjection>, runtime: Runtime, ctx: any): Promise<{
	recent: ReturnType<typeof buildCompactionProjection>["reflections"];
	digest?: ReflectionDigest;
}> {
	const reflections = projection.reflections;
	const budget = reflectionContextBudget(reflectionContextMaxTokens(runtime));
	const previous = projection.reflectionDigest;
	const watermarkIndex = previous ? reflections.findIndex((reflection) => reflection.id === previous.coversThroughReflectionId) : -1;

	if (!previous && reflections.reduce((sum, reflection) => sum + reflection.tokenCount, 0) <= budget.totalTokens) {
		return { recent: reflections };
	}

	const eligible = watermarkIndex >= 0 ? reflections.slice(watermarkIndex + 1) : reflections;
	const { recent, older } = selectRecentReflections(eligible, budget.recentTokens);
	if (older.length === 0) return { recent, ...(previous ? { digest: previous } : {}) };

	let content: string | undefined;
	if (ctx.modelRegistry) {
		const resolved = await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (resolved.ok) {
			content = await runReflectionDigest({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				previousDigest: previous,
				olderReflections: older,
				maxTokens: budget.digestTokens,
			});
		}
	}
	content ??= fallbackDigestContent(previous, older, budget.digestTokens);
	const digest: ReflectionDigest = {
		content,
		coversThroughReflectionId: older.at(-1)!.id,
		tokenCount: digestTokenCount(content),
	};
	return { recent, digest };
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;
			const projection = buildCompactionProjection(
				branchEntries as Entry[],
				firstKeptEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const reflectionContext = await buildReflectionContext(projection, runtime, ctx);
			const summary = renderSummary(projection.reflections, projection.observations, reflectionContext);
			const details = reflectionContext.digest
				? { ...projection.details, reflectionDigest: reflectionContext.digest }
				: projection.details;

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}

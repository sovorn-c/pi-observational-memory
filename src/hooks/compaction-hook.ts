import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { digestFitsBudget, reflectionContextBudget } from "../reflection-context.js";
import type { Runtime } from "../runtime.js";
import { buildCompactionProjection, renderSummary, type Entry } from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;
const DEFAULT_REFLECTION_CONTEXT_MAX_TOKENS = 10_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

function reflectionContextMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { reflectionContextMaxTokens?: unknown }).reflectionContextMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_REFLECTION_CONTEXT_MAX_TOKENS;
}

function buildReflectionContext(
	projection: ReturnType<typeof buildCompactionProjection>,
	runtime: Runtime,
): {
	recent: ReturnType<typeof buildCompactionProjection>["reflections"];
	digest?: ReturnType<typeof buildCompactionProjection>["reflectionDigest"];
} {
	const digest = projection.reflectionDigest;
	const budget = reflectionContextBudget(reflectionContextMaxTokens(runtime));
	if (!digestFitsBudget(digest, budget)) return { recent: projection.reflections };
	if (!digest) return { recent: projection.reflections };
	const watermarkIndex = projection.reflections.findIndex(
		(reflection) => reflection.id === digest.coversThroughReflectionId,
	);
	if (watermarkIndex < 0) return { recent: projection.reflections };
	return { digest, recent: projection.reflections.slice(watermarkIndex + 1) };
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
			const reflectionContext = buildReflectionContext(projection, runtime);
			const summary = renderSummary(projection.reflections, projection.observations, reflectionContext);

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}

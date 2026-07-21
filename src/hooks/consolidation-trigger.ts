import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { runReflectionDigest } from "../agents/reflection-digest.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { digestFitsBudget, digestTokenCount, reflectionContextBudget, selectRecentReflections } from "../reflection-context.js";
import { type ResolveResult, type Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	OM_REFLECTION_DIGEST_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionDigestRecordedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Reflection,
	type ReflectionDigest,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
	outcome: StageOutcome;
	sameRunReflections: Reflection[];
	effectiveReflectionCoverageId?: string;
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
	const seen = new Set(existing.map((reflection) => reflection.id));
	const merged = [...existing];
	for (const reflection of additional) {
		if (seen.has(reflection.id)) continue;
		seen.add(reflection.id);
		merged.push(reflection);
	}
	return merged;
}

function anyStageDue(entries: Entry[], runtime: Runtime): boolean {
	return rawTokensSinceObservationCoverage(entries) >= runtime.config.observeAfterTokens
		|| rawTokensSinceReflectionCoverage(entries) >= runtime.config.reflectAfterTokens;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer" | "reflector" | "reflection-digest" | "dropper") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime)) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(pi, runtime, ctx, resolveModel, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId);
	} catch (error) {
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}

	runtime.consolidationPhase = "reflection-digest";
	try {
		await runReflectionDigestStage(pi, runtime, ctx, resolveModel, reflectorResult.sameRunReflections);
	} catch (error) {
		debugLog("reflection_digest.error", {
			errorMessage: runtime.recordConsolidationStageError(ctx, "reflection-digest", error),
		});
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = rawTokensSinceObservationCoverage(entries);
	if (tokens < runtime.config.observeAfterTokens) return "continue";

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const chunkEntries = sourceEntriesAfter(entries, lastCoverageIdx);
	const coversUpToId = chunkEntries.at(-1)?.id;
	if (!coversUpToId) return "continue";

	const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: observer running on ~${tokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
	});

	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";

	const observations = await runObserver({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		priorReflections,
		priorObservations,
		chunk,
		allowedSourceEntryIds: sourceEntryIds,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!observations || observations.length === 0) {
		debugLog("observer.empty", { coversUpToId });
		if (ctx.hasUI) ctx.ui?.notify(
			"Observational memory: observer returned no observations",
			"warning",
		);
		return "continue";
	}

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const reflectionTokens = rawTokensSinceReflectionCoverage(entries);
	if (reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
		"info",
	);
	const resolved = await resolveModel("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };

	const folded = foldLedger(entries);
	const reflections = await runReflector({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: folded.reflections,
		observations: folded.activeObservations,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!reflections) return { outcome: "continue", sameRunReflections: [] };

	const data = buildReflectionsRecordedData(reflections, observationCoverageId);
	if (!data) return { outcome: "continue", sameRunReflections: [] };
	appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	return {
		outcome: "continue",
		sameRunReflections: reflections,
		effectiveReflectionCoverageId: data.coversUpToId,
	};
}

function reflectionIdsMatchPrefix(current: readonly Reflection[], expected: readonly Reflection[]): boolean {
	if (current.length < expected.length) return false;
	return expected.every((reflection, index) => current[index]?.id === reflection.id);
}

function digestCoverageIndex(reflections: readonly Reflection[], digest: ReflectionDigest | undefined): number {
	return digest
		? reflections.findIndex((reflection) => reflection.id === digest.coversThroughReflectionId)
		: -1;
}

async function runReflectionDigestStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflection-digest") => Promise<ResolvedModel | undefined>,
	sameRunReflections: Reflection[],
): Promise<StageOutcome> {
	if (sameRunReflections.length === 0) return "continue";

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const reflections = folded.reflections;
	const persistedDigest = folded.reflectionDigest;
	const budget = reflectionContextBudget(runtime.config.reflectionContextMaxTokens);
	const rebuildDigest = !digestFitsBudget(persistedDigest, budget);
	const previous = rebuildDigest ? undefined : persistedDigest;
	const previousCoverage = digestCoverageIndex(reflections, previous);
	const eligible = previousCoverage >= 0 ? reflections.slice(previousCoverage + 1) : reflections;
	const uncoveredTokens = eligible.reduce((sum, reflection) => sum + reflection.tokenCount, 0);

	if (!rebuildDigest && uncoveredTokens <= budget.recentTokens) {
		debugLog("reflection_digest.not_ready", {
			uncoveredReflectionCount: eligible.length,
			uncoveredTokens,
			highWaterTokens: budget.recentTokens,
		});
		return "continue";
	}

	let { older } = selectRecentReflections(eligible, budget.recentTargetTokens);
	const persistedCoverage = digestCoverageIndex(reflections, persistedDigest);
	if (rebuildDigest && persistedCoverage >= 0) {
		const selectedTarget = older.at(-1);
		const selectedCoverage = selectedTarget
			? reflections.findIndex((reflection) => reflection.id === selectedTarget.id)
			: -1;
		if (persistedCoverage > selectedCoverage) older = reflections.slice(0, persistedCoverage + 1);
	}
	const target = older.at(-1);
	if (!target) return "continue";
	const targetIndex = reflections.findIndex((reflection) => reflection.id === target.id);
	if (targetIndex < 0) return "continue";
	const expectedPrefix = reflections.slice(0, targetIndex + 1);

	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: reflection digest updating (~${uncoveredTokens.toLocaleString()} uncovered tokens)`,
		"info",
	);
	debugLog("reflection_digest.start", {
		previousCoverageId: previous?.coversThroughReflectionId,
		rebuildingOversizedDigest: rebuildDigest,
		uncoveredReflectionCount: eligible.length,
		uncoveredTokens,
		digestReflectionCount: older.length,
		targetCoverageId: target.id,
		digestBudgetTokens: budget.digestTokens,
		postUpdateRecentTargetTokens: budget.recentTargetTokens,
	});

	const resolved = await resolveModel("reflection-digest");
	if (!resolved) return "continue";
	const content = await runReflectionDigest({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		previousDigest: previous,
		olderReflections: older,
		maxTokens: budget.digestTokens,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!content) {
		debugLog("reflection_digest.empty", { targetCoverageId: target.id });
		if (ctx.hasUI) ctx.ui?.notify(
			"Observational memory: reflection digest returned no usable content",
			"warning",
		);
		return "continue";
	}

	const digest: ReflectionDigest = {
		content,
		coversThroughReflectionId: target.id,
		tokenCount: digestTokenCount(content),
	};
	const data = buildReflectionDigestRecordedData(digest);
	if (!data) return "continue";

	const currentEntries = ctx.sessionManager.getBranch() as Entry[];
	const currentFolded = foldLedger(currentEntries);
	if (!reflectionIdsMatchPrefix(currentFolded.reflections, expectedPrefix)) {
		debugLog("reflection_digest.discarded", { reason: "reflection_prefix_changed", targetCoverageId: target.id });
		return "continue";
	}
	const currentCoverage = digestCoverageIndex(currentFolded.reflections, currentFolded.reflectionDigest);
	if (digestFitsBudget(currentFolded.reflectionDigest, budget) && currentCoverage >= targetIndex) {
		debugLog("reflection_digest.discarded", { reason: "checkpoint_already_current", targetCoverageId: target.id });
		return "continue";
	}

	appendEntry(pi, OM_REFLECTION_DIGEST_RECORDED, data);
	debugLog("reflection_digest.appended", {
		coversThroughReflectionId: digest.coversThroughReflectionId,
		tokenCount: digest.tokenCount,
	});
	return "continue";
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
): Promise<StageOutcome> {
	if (!sameRunReflectionCoverageId || sameRunReflections.length === 0) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) {
		debugLog("dropper.not_ready", {
			observationTokens: metrics.observationTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeObservationCount: metrics.activeObservationCount,
			droppableCount: metrics.droppableCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("dropper.stage_start", {
		observationCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (ctx.hasUI) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const resolved = await resolveModel("dropper");
	if (!resolved) return "abort";

	const reflectionsForDropper = mergeReflections(folded.reflections, sameRunReflections);
	const droppedIds = await runDropper({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: reflectionsForDropper,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, sameRunReflectionCoverageId);
	const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
	debugLog("dropper.append", {
		droppedIdsCount: droppedIds?.length ?? 0,
		coversUpToId,
		dataBuilt: data !== undefined,
		appended: data !== undefined,
	});
	if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
	return "continue";
}

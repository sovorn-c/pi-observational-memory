import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { runObserver } from "../agents/observer/agent.js";
import type { Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_RECORDED,
	buildObservationsRecordedData,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	observationToSummaryLine,
	rawTokensSinceObservationCoverage,
	reflectionToSummaryLine,
	type Entry,
} from "../session-ledger/index.js";

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

export function registerObserverTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.observerInFlight) return;

		const entries = ctx.sessionManager.getBranch() as Entry[];
		const tokens = rawTokensSinceObservationCoverage(entries);
		if (tokens < runtime.config.observeAfterTokens) return;

		const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
		const chunkEntries = sourceEntriesAfter(entries, lastCoverageIdx);
		const coversUpToId = chunkEntries.at(-1)?.id;
		if (!coversUpToId) return;

		const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
		if (!chunk.trim() || sourceEntryIds.length === 0) return;

		const memory = fullProjection(entries);
		const priorReflections = memory.reflections.map(reflectionToSummaryLine);
		const priorObservations = memory.observations.map(observationToSummaryLine);

		if (ctx.hasUI) ctx.ui.notify(
			`Observational memory: observer running on ~${tokens.toLocaleString()}-token chunk`,
			"info",
		);
		const runId = `observer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const model = ctx.model;
		const modelRegistry = ctx.modelRegistry;
		const cwd = ctx.cwd;

		void runtime.launchObserverTask(ctx, "observer", async () => withDebugLogContext({ enabled: runtime.config.debugLog === true, cwd, runId }, async () => {
			try {
				debugLog("observer.start", {
					tokens,
					coversUpToId,
					sourceEntryIds,
					sourceEntryCount: sourceEntryIds.length,
					priorReflections: priorReflections.length,
					priorObservations: priorObservations.length,
				});
				const resolved = await runtime.resolveModel({ model, modelRegistry, hasUI, ui });
				if (!resolved.ok) {
					debugLog("observer.model_unavailable", { reason: resolved.reason });
					if (!runtime.resolveFailureNotified && hasUI && ui) {
						ui.notify(
							`Observational memory: observer skipped — ${resolved.reason}`,
							"warning",
						);
						runtime.resolveFailureNotified = true;
					}
					return;
				}
				runtime.resolveFailureNotified = false;

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
					if (hasUI && ui) ui.notify(
						"Observational memory: observer returned no observations",
						"warning",
					);
					return;
				}

				const data = buildObservationsRecordedData(observations, coversUpToId);
				if (!data) return;
				debugLog("observer.records", {
					count: observations.length,
					observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
					coversUpToId,
					observations,
				});
				pi.appendEntry(OM_OBSERVATIONS_RECORDED, data);
				debugLog("observer.appended", { count: observations.length, coversUpToId });
				if (hasUI && ui) ui.notify(
					`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
					"info",
				);
			} catch (error) {
				debugLog("observer.error", { errorMessage: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}));
	});
}

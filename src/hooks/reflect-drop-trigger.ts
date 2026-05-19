import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	latestCoverageMarkerId,
	rawTokensSinceDropCoverage,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	type Entry,
	type Reflection,
} from "../session-ledger/index.js";

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

export function registerReflectDropTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.observerInFlight || runtime.reflectDropInFlight) return;

		const entries = ctx.sessionManager.getBranch() as Entry[];
		if (rawTokensSinceObservationCoverage(entries) >= runtime.config.observeAfterTokens) return;

		const reflectionTokens = rawTokensSinceReflectionCoverage(entries);
		const dropTokens = rawTokensSinceDropCoverage(entries);
		const reflectionDue = reflectionTokens >= runtime.config.reflectAfterTokens;
		const dropDue = dropTokens >= runtime.config.reflectAfterTokens;
		if (!reflectionDue && !dropDue) return;

		if (ctx.hasUI) ctx.ui.notify(
			`Observational memory: reflect/drop running (reflection ~${reflectionTokens.toLocaleString()} tokens, drop ~${dropTokens.toLocaleString()} tokens)`,
			"info",
		);
		const runId = `reflect-drop-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const model = ctx.model;
		const modelRegistry = ctx.modelRegistry;
		const cwd = ctx.cwd;

		void runtime.launchReflectDropTask(ctx, "reflect/drop", async () => withDebugLogContext({ enabled: runtime.config.debugLog === true, cwd, runId }, async () => {
			const resolved = await runtime.resolveModel({ model, modelRegistry, hasUI, ui });
			if (!resolved.ok) {
				debugLog("reflect_drop.model_unavailable", { reason: resolved.reason });
				if (!runtime.resolveFailureNotified && hasUI && ui) {
					ui.notify(`Observational memory: reflect/drop skipped — ${resolved.reason}`, "warning");
					runtime.resolveFailureNotified = true;
				}
				return;
			}
			runtime.resolveFailureNotified = false;

			const currentEntries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(currentEntries);
			let reflectionsForDropper: Reflection[] = folded.reflections;
			const observationCoverageId = latestCoverageMarkerId(currentEntries, OM_OBSERVATIONS_RECORDED);
			let effectiveReflectionCoverageId = latestCoverageMarkerId(currentEntries, OM_REFLECTIONS_RECORDED);

			if (reflectionDue && observationCoverageId) {
				const reflections = await runReflector({
					model: resolved.model as any,
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					reflections: folded.reflections,
					observations: folded.activeObservations,
					maxTurns: runtime.config.agentMaxTurns,
					thinkingLevel: runtime.config.model?.thinking ?? "low",
				});
				if (reflections) {
					const data = buildReflectionsRecordedData(reflections, observationCoverageId);
					if (data) {
						appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
						effectiveReflectionCoverageId = data.coversUpToId;
						reflectionsForDropper = [...folded.reflections, ...reflections];
					}
				}
			}

			if (dropDue && observationCoverageId) {
				const droppedIds = await runDropper({
					model: resolved.model as any,
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					reflections: reflectionsForDropper,
					observations: folded.activeObservations,
					budgetTokens: runtime.config.observationsPoolMaxTokens,
					maxTurns: runtime.config.agentMaxTurns,
					thinkingLevel: runtime.config.model?.thinking ?? "low",
				});
				const coversUpToId = earlierCoverageMarkerId(currentEntries, observationCoverageId, effectiveReflectionCoverageId);
				const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
				if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
			}
		}));
	});
}

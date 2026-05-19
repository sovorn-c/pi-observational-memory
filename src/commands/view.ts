import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import {
	diffProjection,
	fullProjection,
	observationToSummaryLine,
	reflectionToSummaryLine,
	visibleProjection,
	type Entry,
	type Observation,
	type Projection,
	type Reflection,
} from "../session-ledger/index.js";

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return n === 1 ? singular : pluralForm;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function firstArg(args: unknown): string | undefined {
	if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
	if (typeof args === "string") return args.trim().split(/\s+/)[0];
	if (args && typeof args === "object" && "mode" in args) {
		const mode = (args as { mode?: unknown }).mode;
		return typeof mode === "string" ? mode : undefined;
	}
	return undefined;
}

function renderList<T>(items: T[], render: (item: T) => string): string {
	return items.length > 0 ? items.map(render).join("\n") : "(none)";
}

function renderProjection(title: string, projection: Projection): string {
	const observationTokens = tokenSum(projection.observations);
	const reflectionTokens = tokenSum(projection.reflections);
	return [
		`${title}: ${projection.reflections.length} ${plural(projection.reflections.length, "reflection")} · ${projection.observations.length} ${plural(projection.observations.length, "observation")} · ~${(observationTokens + reflectionTokens).toLocaleString()} tokens`,
		"",
		`── Reflections (${projection.reflections.length}, ~${reflectionTokens.toLocaleString()} tokens) ──`,
		renderList(projection.reflections, reflectionToSummaryLine),
		"",
		`── Observations (${projection.observations.length}, ~${observationTokens.toLocaleString()} tokens) ──`,
		renderList(projection.observations, observationToSummaryLine),
	].join("\n");
}

function renderObservationDiff(title: string, observations: Observation[]): string[] {
	return [
		`── ${title} (${observations.length}) ──`,
		renderList(observations, observationToSummaryLine),
	];
}

function renderReflectionDiff(title: string, reflections: Reflection[]): string[] {
	return [
		`── ${title} (${reflections.length}) ──`,
		renderList(reflections, reflectionToSummaryLine),
	];
}

export function registerViewCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om-view", {
		description: "Print observational memory details (visible, full, or diff)",
		handler: async (args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const mode = firstArg(args) ?? "visible";
			const visible = visibleProjection(entries);

			if (mode === "full") {
				ctx.ui.notify(renderProjection("Memory view: full", fullProjection(entries)), "info");
				return;
			}

			if (mode === "diff") {
				const full = fullProjection(entries);
				const diff = diffProjection(visible, full);
				const lines = [
					"Memory diff: visible vs full",
					`Summary: +${diff.observationsOnlyInFull.length} observations, +${diff.reflectionsOnlyInFull.length} reflections, ${diff.droppedOnlyInFull.length} visible observations absent from full active truth`,
					"",
					...renderObservationDiff("Observations only in full", diff.observationsOnlyInFull),
					"",
					...renderReflectionDiff("Reflections only in full", diff.reflectionsOnlyInFull),
					"",
					...renderObservationDiff("Visible observations dropped in full truth", diff.droppedOnlyInFull),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.notify(renderProjection("Memory view: visible", visible), "info");
		},
	});
}

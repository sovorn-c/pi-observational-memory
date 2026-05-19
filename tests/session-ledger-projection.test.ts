import { describe, expect, it } from "vitest";

import {
	buildCompactionProjection,
	diffProjection,
	fullProjection,
	latestFullFoldBoundaryId,
	visibleProjection,
} from "../src/session-ledger/index.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("session-ledger V3 projections", () => {
	it("full projection folds observations, reflections, and drops through the target", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const obs2 = observation("bbbbbbbbbbbb");
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1, obs2], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-eeeeeeeeeeee" }),
		];

		const projection = fullProjection(entries);

		expect(projection.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(projection.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
	});

	it("visible projection is empty when there is no V3 compaction", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [], reflections: [] });
	});

	it("visible projection uses the latest valid om.folded compaction details", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const obs2 = observation("bbbbbbbbbbbb");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obs1], reflections: [] }) }),
			textCustomMessage("raw-2", "bbbb"),
			compactionEntry("cmp-2", { firstKeptEntryId: "raw-2", details: memoryDetails({ fullFold: true, observations: [obs2], reflections: [ref1] }) }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [obs2], reflections: [ref1] });
	});

	it("ignores old V2 compaction details for visible projection", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [], reflections: [] });
	});

	it("finds the latest full-fold boundary", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true }) }),
			textCustomMessage("raw-2", "bbbb"),
			compactionEntry("cmp-2", { firstKeptEntryId: "raw-2", details: memoryDetails({ fullFold: false }) }),
			textCustomMessage("raw-3", "cccc"),
			compactionEntry("cmp-3", { firstKeptEntryId: "raw-3", details: memoryDetails({ fullFold: true }) }),
		];

		expect(latestFullFoldBoundaryId(entries)).toBe("raw-3");
	});

	it("normal compaction projection includes current observations but keeps reflections and drops at latest full-fold boundary", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "om-eeeeeeeeeeee", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ffffffffffff" }),
		];

		const result = buildCompactionProjection(entries, "om-drop-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(false);
		expect(result.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(result.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(result.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
	});

	it("full compaction projection applies reflections and drops through current boundary", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "om-eeeeeeeeeeee", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ffffffffffff" }),
		];

		const result = buildCompactionProjection(entries, "om-drop-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(true);
		expect(result.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
		expect(result.details).toMatchObject({ type: "om.folded", version: 1, fullFold: true });
	});

	it("uses >= observationsPoolMaxTokens for full-fold pressure", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 50 });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
		];

		expect(buildCompactionProjection(entries, "om-aaaaaaaaaaaa", { observationsPoolMaxTokens: 50 }).fullFold).toBe(true);
	});

	it("reports visible/full drift", () => {
		const visible = { observations: [observation("aaaaaaaaaaaa")], reflections: [] };
		const full = {
			observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
			reflections: [reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"])],
		};

		const diff = diffProjection(visible, full);

		expect(diff.observationsOnlyInFull.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(diff.reflectionsOnlyInFull.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
	});
});

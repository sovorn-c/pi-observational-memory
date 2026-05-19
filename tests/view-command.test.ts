import { describe, expect, it, vi } from "vitest";

import { registerViewCommand } from "../src/commands/view.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(entries: TestEntry[]) {
	let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om-view");
			handler = command.handler;
		}),
	};
	const runtime = { ensureConfig: vi.fn() };
	registerViewCommand(pi as any, runtime as any);
	if (!handler) throw new Error("view handler not registered");
	const notify = vi.fn();
	const ctx = { cwd: "/tmp/project", ui: { notify }, sessionManager: { getBranch: () => entries } };
	const run = async (args: unknown = []) => {
		await handler!(args, ctx);
		return notify.mock.calls.at(-1)?.[0] as string;
	};
	return { run, notify };
}

describe("V3 /om-view", () => {
	it("renders no-memory visible output without V2 committed/pending language", async () => {
		const output = await setup([]).run();

		expect(output).toContain("Memory view: visible");
		expect(output).toContain("0 reflections · 0 observations");
		expect(output).toContain("── Reflections (0");
		expect(output).toContain("── Observations (0");
		expect(output).not.toContain("committed");
		expect(output).not.toContain("pending");
	});

	it("default view renders latest visible om.folded memory", async () => {
		const obs = observation("aaaaaaaaaaaa");
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [observation("bbbbbbbbbbbb")], coversUpToId: "raw-1" }),
			compactionEntry("cmp", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obs], reflections: [ref] }) }),
		];

		const output = await setup(entries).run();

		expect(output).toContain("Memory view: visible");
		expect(output).toContain("[eeeeeeeeeeee] Reflection eeeeeeeeeeee");
		expect(output).toContain("[aaaaaaaaaaaa]");
		expect(output).not.toContain("bbbbbbbbbbbb");
	});

	it("full view folds V3 ledger truth and ignores old V2 memory", async () => {
		const obsA = observation("aaaaaaaaaaaa");
		const obsB = observation("bbbbbbbbbbbb");
		const ref = reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ref" }),
		];

		const output = await setup(entries).run(["full"]);

		expect(output).toContain("Memory view: full");
		expect(output).toContain("[eeeeeeeeeeee] Reflection eeeeeeeeeeee");
		expect(output).toContain("[bbbbbbbbbbbb]");
		expect(output).not.toContain("[aaaaaaaaaaaa]");
		expect(output).not.toContain("v2-obs");
		expect(output).not.toContain("observational-memory");
	});

	it("diff view renders visible/full drift", async () => {
		const obsA = observation("aaaaaaaaaaaa");
		const obsB = observation("bbbbbbbbbbbb");
		const ref = reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obsA], reflections: [] }) }),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
		];

		const output = await setup(entries).run(["diff"]);

		expect(output).toContain("Memory diff: visible vs full");
		expect(output).toContain("+1 observations, +1 reflections");
		expect(output).toContain("── Observations only in full (1) ──");
		expect(output).toContain("[bbbbbbbbbbbb]");
		expect(output).toContain("── Reflections only in full (1) ──");
		expect(output).toContain("[eeeeeeeeeeee]");
	});
});

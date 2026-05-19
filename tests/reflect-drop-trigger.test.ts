import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runReflector: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

import { registerReflectDropTrigger } from "../src/hooks/reflect-drop-trigger.js";
import { OM_OBSERVATIONS_DROPPED, OM_REFLECTIONS_RECORDED } from "../src/session-ledger/index.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	mockAgents.runReflector.mockReset();
	mockAgents.runDropper.mockReset();
});

function setup(args: {
	entries: TestEntry[];
	observeAfterTokens?: number;
	reflectAfterTokens?: number;
	passive?: boolean;
	observerInFlight?: boolean;
	reflectDropInFlight?: boolean;
	appendEntryReturnsId?: boolean;
	getLeafId?: boolean;
}) {
	let entries = [...args.entries];
	let handler: ((event: unknown, ctx: any) => void) | undefined;
	const pi = {
		on: vi.fn((eventName: string, cb: typeof handler) => {
			expect(eventName).toBe("turn_end");
			handler = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return args.appendEntryReturnsId === false ? undefined : id;
		}),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	const runtime = {
		config: {
			passive: args.passive ?? false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 999,
			reflectAfterTokens: args.reflectAfterTokens ?? 1,
			observationsPoolMaxTokens: 100,
			agentMaxTurns: 9,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
		},
		observerInFlight: args.observerInFlight ?? false,
		reflectDropInFlight: args.reflectDropInFlight ?? false,
		resolveFailureNotified: false,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key", headers: { h: "v" } })),
		launchReflectDropTask: vi.fn((_ctx, _label, work) => {
			launchedWork = async () => {
				try {
					await work();
				} catch {
					// Runtime.launchReflectDropTask records and swallows worker errors.
				}
			};
			return Promise.resolve();
		}),
	};
	registerReflectDropTrigger(pi as any, runtime as any);
	if (!handler) throw new Error("reflect/drop handler not registered");
	const sessionManager: { getBranch: () => TestEntry[]; getLeafId?: () => string | undefined } = {
		getBranch: () => entries,
	};
	if (args.getLeafId !== false) sessionManager.getLeafId = () => entries.at(-1)?.id;
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: {},
		sessionManager,
	};
	return { pi, runtime, ctx, fire: () => handler!(undefined, ctx), runLaunchedWork: async () => launchedWork?.(), getEntries: () => entries };
}

describe("V3 reflect/drop trigger", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
	const refA = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("does not launch when neither clock is due", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];
		const { fire, runtime } = setup({ entries, reflectAfterTokens: 10 });

		fire();

		expect(runtime.launchReflectDropTask).not.toHaveBeenCalled();
	});

	it("preserves observer priority when observation is due", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runtime } = setup({ entries, observeAfterTokens: 1, reflectAfterTokens: 1 });

		fire();

		expect(runtime.launchReflectDropTask).not.toHaveBeenCalled();
	});

	it("runs reflector-only and appends non-empty reflections", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsDroppedEntry("om-drop", { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ observations: [obsA], maxTurns: 9, thinkingLevel: "minimal" }));
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" });
	});

	it("runs dropper-only and appends non-empty drops", async () => {
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [refA], observations: [obsA] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" });
	});

	it("caps drop coverage at reflection coverage when reflections lag observations", async () => {
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, reflectAfterTokens: 3 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-1" });
	});

	it("caps drop coverage at observation coverage when observations lag reflections", async () => {
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" });
	});

	it("bootstraps drop coverage from observation coverage when no reflection coverage exists", async () => {
		mockAgents.runReflector.mockResolvedValueOnce(undefined);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" });
	});

	it("does not append reflect/drop entries without observation coverage", async () => {
		mockAgents.runReflector.mockResolvedValueOnce([reflection("ffffffffffff", ["aaaaaaaaaaaa"])]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("runs reflector before dropper and covers drops through the same-turn reflection coverage marker", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [newRef] }));
		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }]);
	});

	it("does not use appended reflection entry id for drop coverage when appendEntry returns no id", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, appendEntryReturnsId: false, getLeafId: false });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [newRef] }));
		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }]);
	});

	it("appends no empty entries", async () => {
		mockAgents.runReflector.mockResolvedValueOnce(undefined);
		mockAgents.runDropper.mockResolvedValueOnce(undefined);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("reflector failure skips same-turn dropper", async () => {
		mockAgents.runReflector.mockRejectedValueOnce(new Error("reflect failed"));
		const entries = [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("dropper failure does not roll back appended reflections", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockRejectedValueOnce(new Error("drop failed"));
		const entries = [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" });
	});
});

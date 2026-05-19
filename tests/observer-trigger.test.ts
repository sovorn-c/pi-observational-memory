import { describe, expect, it, vi } from "vitest";

const mockObserver = vi.hoisted(() => ({
	runObserver: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", () => ({
	runObserver: mockObserver.runObserver,
}));

import { registerObserverTrigger } from "../src/hooks/observer-trigger.js";
import { OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.js";
import {
	observation,
	observationsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(args: { entries: TestEntry[]; observeAfterTokens?: number; observerInFlight?: boolean; runObserverResult?: unknown }) {
	mockObserver.runObserver.mockReset();
	mockObserver.runObserver.mockResolvedValue(args.runObserverResult);
	let handler: ((event: unknown, ctx: any) => void) | undefined;
	const pi = {
		on: vi.fn((eventName: string, cb: typeof handler) => {
			expect(eventName).toBe("turn_end");
			handler = cb;
		}),
		appendEntry: vi.fn(),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	const runtime = {
		config: {
			passive: false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 1,
			agentMaxTurns: 7,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
		},
		observerInFlight: args.observerInFlight ?? false,
		resolveFailureNotified: false,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key", headers: { h: "v" } })),
		launchObserverTask: vi.fn((_ctx, _label, work) => {
			launchedWork = work;
			return Promise.resolve();
		}),
	};
	registerObserverTrigger(pi as any, runtime as any);
	if (!handler) throw new Error("observer handler not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: {},
		sessionManager: {
			getBranch: () => args.entries,
		},
	};
	const fire = () => handler!(undefined, ctx);
	return { pi, runtime, ctx, fire, runLaunchedWork: async () => launchedWork?.() };
}

describe("V3 observer trigger", () => {
	it("does not launch below observeAfterTokens", () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { fire, runtime } = setup({ entries, observeAfterTokens: 10 });

		fire();

		expect(runtime.launchObserverTask).not.toHaveBeenCalled();
	});

	it("does not launch while observer is already in flight", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runtime } = setup({ entries, observerInFlight: true });

		fire();

		expect(runtime.launchObserverTask).not.toHaveBeenCalled();
	});

	it("appends om.observations.recorded with V3 data when observations are produced", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, runObserverResult: [obs] });

		fire();
		await runLaunchedWork();

		expect(runtime.launchObserverTask).toHaveBeenCalled();
		expect(mockObserver.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["raw-1"],
			maxTurns: 7,
			thinkingLevel: "minimal",
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, {
			observations: [obs],
			coversUpToId: "raw-1",
		});
	});

	it("appends nothing when observer returns no observations", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries, runObserverResult: undefined });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("uses existing observation coverage and retries larger ranges after no-output", async () => {
		const prior = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] });
		const newObs = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"] });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [prior], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccc"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, runObserverResult: [newObs] });

		fire();
		await runLaunchedWork();

		expect(mockObserver.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["raw-2", "raw-3"],
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, {
			observations: [newObs],
			coversUpToId: "raw-3",
		});
	});

	it("skips appending and notifies once when model resolution fails", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });
		runtime.resolveModel.mockResolvedValueOnce({ ok: false, reason: "no model" });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Observational memory: observer skipped — no model", "warning");
	});
});

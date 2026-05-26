import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { DEFAULTS, loadConfig, readEnvConfig } from "../src/config.js";

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("V3 config", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-v3-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses V3 defaults", () => {
		expect(DEFAULTS).toEqual({
			observeAfterTokens: 10000,
			reflectAfterTokens: 20000,
			compactAfterTokens: 81000,
			observationsPoolMaxTokens: 20000,
			observationsPoolTargetTokens: 10000,
			agentMaxTurns: 16,
			passive: false,
			debugLog: false,
		});
		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("merges global, project, and env V3 settings in order", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 10,
				reflectAfterTokens: 20,
				compactAfterTokens: 30,
				observationsPoolMaxTokens: 40,
				observationsPoolTargetTokens: 15,
				agentMaxTurns: 5,
				model: { provider: "anthropic", id: "global", thinking: "medium" },
				passive: false,
				debugLog: true,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 100,
				model: { provider: "openai", id: "project", thinking: "low" },
			},
		});

		expect(loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "true" })).toMatchObject({
			observeAfterTokens: 100,
			reflectAfterTokens: 20,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 15,
			agentMaxTurns: 5,
			model: { provider: "openai", id: "project", thinking: "low" },
			passive: true,
			debugLog: true,
		});
	});

	it("ignores invalid V3 values", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: -1,
				reflectAfterTokens: 0,
				compactAfterTokens: 1.5,
				observationsPoolMaxTokens: "20000",
				observationsPoolTargetTokens: "10000",
				agentMaxTurns: null,
				model: { provider: "anthropic", id: "", thinking: "huge" },
				passive: "yes",
				debugLog: "true",
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("derives observation pool target from the final max when omitted", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("falls back to derived target when explicit target is invalid for the final max", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 100,
				observationsPoolTargetTokens: 80,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("ignores old V2 settings without warnings or aliases", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationThresholdTokens: 10,
				compactionThresholdTokens: 20,
				reflectionThresholdTokens: 30,
				compactionModel: { provider: "anthropic", id: "old" },
				thinkingLevel: "high",
				observerMaxTurnsPerRun: 2,
				reflectorMaxTurnsPerPass: 3,
				prunerMaxTurnsPerPass: 4,
				compactionMaxToolCalls: 5,
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("parses passive env override", () => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "on" })).toEqual({ passive: true });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "0" })).toEqual({ passive: false });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "maybe" })).toEqual({});
	});
});

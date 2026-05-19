import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";

function modelRegistry(args: { found?: unknown; auth?: unknown } = {}) {
	return {
		find: vi.fn(() => args.found),
		getApiKeyAndHeaders: vi.fn(async () => args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } }),
	};
}

describe("Runtime V3 behavior", () => {
	it("uses configured model when present", async () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const registry = modelRegistry({ found: configured });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" } };

		const result = await runtime.resolveModel({ model: { provider: "openai" }, modelRegistry: registry, hasUI: false });

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({ ok: true, model: configured, apiKey: "key", headers: { test: "yes" } });
	});

	it("falls back to session model and notifies when configured model is missing", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry();
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(result).toMatchObject({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(
			"Observational memory: configured model anthropic/missing not found, using session model",
			"warning",
		);
	});

	it("returns model resolution failures", async () => {
		const runtime = new Runtime();
		await expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).resolves.toEqual({
			ok: false,
			reason: "no model available (session has no model and no observational-memory model configured)",
		});

		const registry = modelRegistry({ auth: { ok: false } });
		await expect(runtime.resolveModel({ model: { provider: "anthropic" }, modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'no API key for provider "anthropic"',
		});
	});

	it("tracks observer task state and captures errors", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const promise = runtime.launchObserverTask({ hasUI: true, ui: { notify } }, "observer", async () => {
			throw new Error("boom");
		});

		expect(runtime.observerInFlight).toBe(true);
		expect(runtime.observerPromise).toBe(promise);
		await promise;
		expect(runtime.observerInFlight).toBe(false);
		expect(runtime.observerPromise).toBeNull();
		expect(runtime.lastObserverError).toBe("boom");
		expect(notify).toHaveBeenCalledWith("Observational memory: observer failed: boom", "warning");
	});

	it("tracks reflect/drop task state independently", async () => {
		const runtime = new Runtime();
		const promise = runtime.launchReflectDropTask({ hasUI: false }, "reflect/drop", async () => {});

		expect(runtime.reflectDropInFlight).toBe(true);
		expect(runtime.reflectDropPromise).toBe(promise);
		await promise;
		expect(runtime.reflectDropInFlight).toBe(false);
		expect(runtime.reflectDropPromise).toBeNull();
		expect(runtime.lastReflectDropError).toBeUndefined();
	});

	it("keeps compaction flags independent", () => {
		const runtime = new Runtime();
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		expect(runtime.observerInFlight).toBe(false);
		expect(runtime.reflectDropInFlight).toBe(false);
	});
});

import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { observationToSummaryLine, reflectionToSummaryLine, type Observation, type Reflection } from "../../session-ledger/index.js";
import { DROPPER_SYSTEM } from "./prompts.js";

interface RunDropperArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	reflections: Reflection[];
	observations: Observation[];
	budgetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const DropObservationsSchema = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	reason: Type.Optional(Type.String()),
});

type DropObservationsArgs = Static<typeof DropObservationsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeDropObservationIds(
	ids: readonly string[] | undefined,
	observations: readonly Observation[],
): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	const allowed = new Map(observations.map((observation) => [observation.id, observation]));
	const result: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const observation = allowed.get(id);
		if (!observation) continue;
		if (observation.relevance === "critical") continue;
		if (seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result.length > 0 ? result : undefined;
}

export async function runDropper(args: RunDropperArgs): Promise<string[] | undefined> {
	const { model, apiKey, headers, reflections, observations, budgetTokens, signal } = args;
	if (observations.length === 0) return undefined;
	const droppedIds: string[] = [];
	const dropped = new Set<string>();

	const dropObservations: AgentTool<typeof DropObservationsSchema> = {
		name: "drop_observations",
		label: "Drop observations",
		description: "Drop active observation ids that are safe to remove from compacted memory.",
		parameters: DropObservationsSchema,
		execute: async (_id, params: DropObservationsArgs) => {
			const normalized = normalizeDropObservationIds(params.ids, observations) ?? [];
			let added = 0;
			for (const id of normalized) {
				if (dropped.has(id)) continue;
				dropped.add(id);
				droppedIds.push(id);
				added++;
			}
			return {
				content: [{ type: "text", text: `Dropped ${added} observation${added === 1 ? "" : "s"}. Total this run: ${droppedIds.length}.` }],
				details: { added, total: droppedIds.length },
			};
		},
	};

	const observationTokens = observations.reduce((sum, observation) => sum + observation.tokenCount, 0);
	const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nCURRENT OBSERVATIONS:\n${joinOrEmpty(observations.map(observationToSummaryLine))}\n\nObservation pool pressure: ~${observationTokens.toLocaleString()} tokens; target budget: ~${budgetTokens.toLocaleString()} tokens. Drop only observations that are safe to remove. If none are safe, do not call the tool.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: DROPPER_SYSTEM, messages: [], tools: [dropObservations as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal);
	for await (const _event of stream) {
		// Tool execution collects ids.
	}
	await stream.result();
	return droppedIds.length > 0 ? droppedIds : undefined;
}

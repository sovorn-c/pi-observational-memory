import { agentLoop, type AgentContext, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { boundedMaxTokens } from "../model-budget.js";
import { estimateStringTokens } from "../tokens.js";
import type { Reflection, ReflectionDigest } from "../session-ledger/index.js";

export const REFLECTION_DIGEST_SYSTEM = `You maintain a compact digest of older durable reflections for an assistant.

Preserve the facts a future assistant needs to avoid wrong decisions: user preferences, constraints, important decisions, rationale, invariants, completed outcomes, durable blockers, and open decisions. Remove transient activity logs, routine details, temporary debugging, duplicates, and superseded facts. When facts conflict, preserve the latest state. Do not invent facts.

Return one concise plain-text digest. It may contain short lines, but do not include commentary about the summarization process. The digest must fit the requested token budget.`;

const RecordDigestSchema = Type.Object({ content: Type.String({ minLength: 1 }) });
type RecordDigestArgs = Static<typeof RecordDigestSchema>;

export interface RunReflectionDigestArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	previousDigest?: ReflectionDigest;
	olderReflections: Reflection[];
	maxTokens: number;
	thinkingLevel?: ModelThinkingLevel;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
}

function reflectionLines(reflections: readonly Reflection[]): string {
	return reflections.map((reflection) => `[${reflection.id}] ${reflection.content}`).join("\n");
}

export async function runReflectionDigest(args: RunReflectionDigestArgs): Promise<string | undefined> {
	if (args.olderReflections.length === 0 && !args.previousDigest) return undefined;
	let digest: string | undefined;
	const recordDigest = {
		name: "record_digest",
		label: "Record reflection digest",
		description: "Record the bounded digest of older durable reflections.",
		parameters: RecordDigestSchema,
		execute: async (_id: string, params: RecordDigestArgs) => {
			digest = params.content.trim();
			return {
				content: [{ type: "text", text: "Reflection digest recorded." }],
				terminate: true,
			};
		},
	} as any;
	const prior = args.previousDigest ? `CURRENT DIGEST:\n${args.previousDigest.content}\n\n` : "";
	const input = `${prior}REFLECTIONS TO INCORPORATE:\n${reflectionLines(args.olderReflections)}\n\nProduce the complete replacement digest. Be as concise as possible, do not aim to fill the budget, and never exceed ${args.maxTokens} tokens.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: REFLECTION_DIGEST_SYSTEM, messages: [], tools: [recordDigest] };
	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const config: AgentLoopConfig = {
		model: args.model,
		apiKey: args.apiKey,
		headers: args.headers,
		maxTokens: boundedMaxTokens(args.model, args.maxTokens),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
	};
	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, args.signal);
	for await (const _event of stream) {
		// Tool execution captures the digest.
	}
	await stream.result();
	if (!digest) return undefined;
	const normalized = digest.replace(/\r/g, "").trim();
	if (!normalized) return undefined;
	return estimateStringTokens(normalized) <= args.maxTokens ? normalized : undefined;
}

import type { Observation, Reflection, ReflectionDigest } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export type SummaryReflectionContext = {
	digest?: ReflectionDigest;
	recent: Reflection[];
};

export function renderSummary(
	reflections: Reflection[],
	observations: Observation[],
	reflectionContext?: SummaryReflectionContext,
): string {
	const visibleReflections = reflectionContext?.recent ?? reflections;
	if (visibleReflections.length === 0 && observations.length === 0 && !reflectionContext?.digest) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (reflectionContext?.digest) {
		parts.push(`## Reflection digest\n${reflectionContext.digest.content}`);
	}
	if (visibleReflections.length > 0) {
		parts.push(`## Reflections\n${visibleReflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (observations.length > 0) {
		parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
	}
	return parts.join("\n\n");
}

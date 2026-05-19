# Observational Memory V3 Specification

V3 is a breaking redesign: no v2 compatibility, no migration layer, no legacy observation/reflection formats, and no attempt to read old `om.observation` entries or old compaction details. The core model is a branch-local memory ledger over Pi’s session tree. Ledger entries are the source of truth; compaction summaries are only agent-visible materialized projections. Memory state at any entry is reconstructed by walking the current branch path from root to that entry and folding memory ledger diffs. Ledger entries are hidden from the agent. Pi compaction still produces the visible summary the agent sees, using Pi’s `firstKeptEntryId` as the boundary for what should be projected into the compaction entry. Old V2 entries/details should be ignored by V3 guards rather than treated as errors: old sessions effectively start with clean V3 memory, while normal Pi conversation history and old visible compaction summary text may still exist until a new V3 compaction replaces it.

The new custom ledger entries are `om.observations.recorded`, `om.reflections.recorded`, and `om.observations.dropped`. Observation shape is `id`, `content`, `timestamp`, `relevance`, `sourceEntryIds`, and `tokenCount`; `sourceEntryIds` should be required and source-backed. Reflection shape is `id`, `content`, `supportingObservationIds`, and `tokenCount`; reflection content should remain simple one-line prose. `om.observations.recorded` data is `{ observations, coversUpToId }`; `om.reflections.recorded` data is `{ reflections, coversUpToId }`; `om.observations.dropped` data is `{ observationIds, coversUpToId }`. We do not need `coversFromId`, because V3 folds from branch root and uses `coversUpToId` as the progress marker for that ledger entry type. `coversUpToId` is a progress watermark for the worker's processed input frontier, not dependency/provenance. Coverage/progress counts raw source tokens after the branch index of `coversUpToId`; this marker does not define what gets passed to agents and should not be used to encode that a worker depended on a particular memory ledger entry. New observer entries use the latest raw/source entry processed; new reflector entries use the latest observation coverage marker; new dropper entries use the earlier branch position of latest observation coverage and latest effective reflection coverage. Observer input still serializes only raw/source entries (`message`, `custom_message`, `branch_summary`). We do not keep entry-level `tokenCount`; token counts live on observations/reflections and are summed when needed. Dropped observations are tombstoned, not deleted: they stop being agent-visible after a full fold, but remain recallable forever through ledger history. Empty memory ledger entries should not be created. If an agent produces no observations, reflections, or drops, the extension appends nothing and that agent's coverage clock does not advance.

```ts
type Relevance = "low" | "medium" | "high" | "critical";

type Observation = {
  id: string;
  content: string;
  timestamp: string;
  relevance: Relevance;
  sourceEntryIds: string[];
  tokenCount: number;
};

type Reflection = {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
};

type ObservationsRecordedEntryData = {
  observations: Observation[];
  coversUpToId: string;
};

type ReflectionsRecordedEntryData = {
  reflections: Reflection[];
  coversUpToId: string;
};

type ObservationsDroppedEntryData = {
  observationIds: string[];
  coversUpToId: string;
};
```

The compaction details shape should be flat and simple: `type: "om.folded"`, `version: 1`, `fullFold: boolean`, `observations: Observation[]`, and `reflections: Reflection[]`. No `MemoryDetailsV3` suffix; just `MemoryDetails`. No projection object, no `foldedThroughEntryId`, no `lastRefreshThroughEntryId`. The Pi compaction payload remains normal Pi shape: `{ summary, firstKeptEntryId, tokensBefore, details }`. `fullFold` replaces the earlier “refreshed” wording. `fullFold: false` means this compaction projected observations while keeping reflections/drop effects stable from the last full fold. `fullFold: true` means this compaction folded the full ledger effects up to the boundary: observations, reflections, and drops. Full folds are the rare cache-breaking consolidation points; normal folds are cache-preserving.

```ts
type MemoryDetails = {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
};
```

The main product goal is instant compaction. Today the painful UX is that compaction can block for minutes while reflector/pruner work runs at the cliff. V3 moves heavy LLM work into background ledger updates during conversation flow, so compaction itself only folds committed ledger state and renders a deterministic summary. If background memory work is behind, compaction does not wait for it; it uses the best committed ledger state. This intentionally trades perfect freshness for uninterrupted flow. Manual/Pi compaction and extension-triggered compaction should stay fast: no observer, reflector, or dropper should be invoked synchronously during compaction.

Auto-compaction keeps the current extension’s general shape, but uses V3 naming and must not wait for background memory agents. The hook remains Pi’s `agent_end`, because it fires after the full agent loop rather than after every turn. The trigger skips when `passive` is true, when compaction is already in flight, or when the final assistant message ended with a retryable provider/network error that Pi is likely to auto-retry. It then counts raw source/session tokens since the last Pi compaction, excluding memory ledger custom entries. If the count is below `compactAfterTokens`, it does nothing. If the threshold is reached, it may notify the user, marks compaction in flight, defers with `setTimeout(0)`, verifies `ctx.isIdle()`, re-reads the branch, re-checks the threshold in case another compaction already happened, and calls `ctx.compact()`. Unlike V2, it does not await observer/reflector/dropper work before compacting; committed ledger entries are enough. Auto-compaction only decides “raw session tail is too large; compact now.” The compaction hook decides whether that compaction is a normal fold or a `fullFold` based on visible observation pool pressure.

Background agents remain agent-loop based and keep the current prompts as much as possible, because they have been working. The agents are observer, reflector, and dropper. The old “pruner/reducer” concept is renamed to dropper. Reflector and dropper run sequentially in the same background invocation, but no longer need multi-pass behavior because they run continuously over time. All agents should share one small underlying runner around `agentLoop`: model/API/header resolution, prompt injection, tool injection, validation, shared max-turn cap, and consistent errors. But keep this boring and direct; no generic framework or clever plugin abstraction. File layout should group each agent’s code and prompt together, for example `agents/observer/agent.ts` plus `prompt.ts`, `agents/reflector/agent.ts` plus `prompt.ts`, `agents/dropper/agent.ts` plus `prompt.ts`, plus one shared runner if it actually reduces duplication.

Triggering happens from Pi’s `turn_end` hook. First check observation need: if raw session tokens after the branch position marked by the last `om.observations.recorded.coversUpToId` reach `observeAfterTokens`, run observer and stop. If the observer produces observations, append `om.observations.recorded` with `coversUpToId` set to the latest branch entry position included in the observer's decision snapshot, usually the latest raw source entry in the observed range. If it produces none, append nothing, leave observation coverage unchanged, and the next eligible observer run will retry over a larger raw range with no cap. Observer and reflector/dropper never run in the same turn; observer has priority.

If observation does not run, check reflector and dropper independently. Each has its own coverage clock: reflector progress is measured from the branch position marked by the last `om.reflections.recorded.coversUpToId`, and dropper progress is measured from the branch position marked by the last `om.observations.dropped.coversUpToId`. `reflectorDue = rawTokensSince(last reflection coverage position) >= reflectAfterTokens`; `dropperDue = rawTokensSince(last drop coverage position) >= reflectAfterTokens`. If neither is due, do nothing. If only one is due, run only that agent. If both are due, run reflector first and dropper second. When both run, the dropper input must include any new reflections produced by the reflector in the same invocation. Append produced entries in order: `om.reflections.recorded` first if any reflections were produced, then `om.observations.dropped` if any drops were produced. Reflector `coversUpToId` should be the latest observation coverage marker, because the reflector operates over observations rather than the current branch leaf. Dropper `coversUpToId` should be the earlier branch position of latest observation coverage and latest effective reflection coverage. Same-turn reflections count as effective reflection coverage through their own internal `coversUpToId`; the drop entry should not use the newly appended reflection entry id as its progress marker. If dependency/provenance such as “dropper used reflection entry R” is ever needed, it should be represented by a separate field rather than overloading `coversUpToId`. If a due agent produces no diffs, append no entry for that agent and leave its coverage clock unchanged, so a future run retries over a larger raw range. `reflectAfterTokens` is based on raw session token progress since that agent type's last coverage marker position, not observation-pool token size. The rough tuning target is `reflectAfterTokens` around 3–6× `observeAfterTokens`.

Projection/cache behavior is the subtle part. The ledger always records observations, reflections, and drops continuously. But if every compaction folded the newest reflections and drops, the agent-visible summary would change high in the prompt too often and break LLM cache unnecessarily. So normal compactions fold observations up to the current `firstKeptEntryId`, while reflections and drops are only folded through the latest full-fold boundary. The observation pool in the visible projection grows over time; `observationsPoolMaxTokens` names that pressure, not “next refresh.” When the visible observation pool exceeds this limit, the next compaction becomes `fullFold: true`, folding reflections and drops too, reducing/removing dropped observations from visible memory, and establishing a new stable baseline. After that, normal compactions continue folding observations only until the pool pressure again calls for a full fold.

Settings are breaking and clean under `"observational-memory"`. Proposed shape: `observeAfterTokens`, `reflectAfterTokens`, `compactAfterTokens`, `observationsPoolMaxTokens`, `agentMaxTurns`, `model: { provider, id, thinking }`, `passive`, and `debugLog`. Use `thinking`, not `thinkingLevel`, and place it inside `model`. Use `model`, not `compactionModel`, because all memory agents share it. `agentMaxTurns` is one shared cap for observer/reflector/dropper. `compactAfterTokens` controls when the extension proactively calls Pi compaction based on raw session tail size. `observationsPoolMaxTokens` is separate: it controls whether a compaction should be a cache-preserving normal fold or a cache-breaking `fullFold`. Keep env override for passive mode via `PI_OBSERVATIONAL_MEMORY_PASSIVE`. `passive: true` disables automatic `turn_end` workloads and disables the `agent_end` auto-compaction detector. It does not disable the compaction hook, manual/Pi compaction, `/om-status`, `/om-view`, or `recall`. In passive mode, compaction still only folds/renders committed ledger state and should remain instant.

```json
{
  "observational-memory": {
    "observeAfterTokens": 1000,
    "reflectAfterTokens": 5000,
    "compactAfterTokens": 50000,
    "observationsPoolMaxTokens": 30000,
    "agentMaxTurns": 16,
    "model": {
      "provider": "anthropic",
      "id": "...",
      "thinking": "low"
    },
    "passive": false,
    "debugLog": false
  }
}
```

Commands split visible projection from ledger truth. `/om-view` defaults to showing visible memory: what the agent currently sees from the latest compaction projection. `/om-view full` folds the full ledger to the branch tip and shows true memory state, including latest reflections/drops even if not projected yet. `/om-view diff` shows the drift: what full ledger truth knows that visible memory does not currently expose. Current `/om-view` sections can inspire the output, but V3 should replace committed/pending language with visible/full/diff language. `/om-status` should answer “is memory healthy and what happens next?” It should show ledger counts, active observations, dropped observations, reflections, latest compaction/projection state, whether the last compaction was `fullFold`, visible-vs-full drift, next observation progress, independent next reflection and next drop progress versus `reflectAfterTokens`, next auto-compaction progress versus `compactAfterTokens`, visible observation pool size versus `observationsPoolMaxTokens`, workers in flight, passive mode, and last error/skipped reason if any.

`recall(id)` keeps the same user-facing tool name, input shape, source excerpt rendering, TUI rendering style, and missing-source warnings as much as possible. The backend lookup changes from current compaction/observation structures to ledger history. For an observation id, recall walks the current branch ledger root to tip, finds the `om.observations.recorded` entry containing that observation, checks later `om.observations.dropped` tombstones, marks it active or dropped, resolves `sourceEntryIds`, and renders the same kind of source evidence. For a reflection id, recall finds the `om.reflections.recorded` entry, reads supporting observation ids, finds those observations in ledger history, checks whether each was later dropped, resolves their source entries, and renders reflection, supporting observations, active/dropped status, and exact source excerpts. Dropped observations remain recallable because drop means “not agent-visible,” not “destroy provenance.”

Implementation should stay intentionally simple. The V3 code should avoid deep call stacks, excessive helper layers, generic frameworks, and abstractions that hide ledger behavior. One lightweight session-tree/session-ledger module is worthwhile because branch walking, custom entry guards, folding, projection, and appending should not be scattered everywhere. But it should be small and explicit: entry types/builders/guards, fold logic, projection helpers, range/progress helpers, and append helpers only where they prevent duplication or unsafe branch handling. General rule: all session-tree reads/writes for memory go through this module, but everything else should remain boring and local. The spec should explicitly protect this simplicity: no backward compatibility, no migration, no compatibility warnings, no empty progress ledger entries, no clever caching beyond the full-fold projection policy, and no synchronous LLM work at compaction time. The test suite should be V3-only; deleted V2 tests do not need to be restored except as optional reference material.

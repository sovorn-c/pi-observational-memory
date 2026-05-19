# Observational Memory V3 Implementation Plan

## Goal

Implement V3 of the Pi observational-memory extension as a breaking redesign centered on a branch-local memory ledger.

The main product goal is **instant compaction**. Compaction must be deterministic and fast: it should fold already-committed ledger entries and render a summary. It must not run or wait for observer, reflector, dropper, model resolution, API key resolution, progress widgets, sync catch-up, or any other LLM work.

V3 deliberately drops V2 compatibility:

- no migration layer
- no legacy observation/reflection formats
- no compatibility warnings
- old `om.observation` custom entries ignored
- old `type: "observational-memory"` compaction details ignored
- old sessions start with clean V3 memory, while old visible compaction summary text may linger until the first V3 compaction replaces it

Pi branch behavior has been confirmed: branch history retains custom ledger entries after compaction. Therefore V3 can use the clean ledger model:

- ledger entries are the source of truth
- fold branch root → target entry
- `om.folded` compaction details are only an agent-visible projection
- no checkpoint fallback is needed

## Core V3 invariants

### Ledger source of truth

Memory truth is reconstructed by folding V3 memory ledger entries along the current branch path.

Valid V3 custom entry types:

```ts
const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
```

Valid V3 compaction details type:

```ts
const OM_FOLDED = "om.folded";
```

Old V2 entries/details are ignored:

- `customType: "om.observation"` does not seed memory
- `details.type: "observational-memory"` does not seed memory
- unknown custom entries do not throw
- unknown details do not throw

### Entry data shapes

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

type MemoryDetails = {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
};
```

### No empty ledger entries

Never append empty memory entries.

If an agent produces no useful output:

- append nothing
- do not advance that agent’s coverage clock
- retry later over a larger range

This applies to:

- observer with zero observations
- reflector with zero reflections
- dropper with zero dropped observation ids
- dedupe/validation producing zero accepted records

### `coversUpToId`

`coversUpToId` is a progress watermark for the worker's processed input frontier.

It does **not** define what is passed to agents, and it is not dependency/provenance. In particular, a drop entry should not use a newly appended reflection entry id as `coversUpToId` merely because the dropper saw that reflection. If dependency/provenance is needed later, it should be represented by a separate field such as `dependsOnEntryIds`, not by overloading `coversUpToId`.

New worker entries choose the marker as follows:

- observer: latest raw/source entry processed (`message`, `custom_message`, or `branch_summary`)
- reflector: latest observation coverage marker, because reflector operates over observations
- dropper: earlier branch position of latest observation coverage and latest effective reflection coverage, because dropper operates over observations plus reflections

Progress calculation:

1. find the branch index of `coversUpToId`
2. count raw/source tokens after that index
3. ignore memory custom entries and compaction entries when counting raw tokens

Observer input still serializes only raw/source entries.

### Reflector/dropper sequencing

Observer has priority and never runs in the same turn as reflector/dropper.

If observer is not due, reflector and dropper are checked independently:

- reflector clock: last `om.reflections.recorded.coversUpToId`
- dropper clock: last `om.observations.dropped.coversUpToId`

Cases:

- neither due: do nothing
- only reflector due: run reflector
- only dropper due: run dropper
- both due: run reflector first, then dropper

If both run:

1. reflector produces reflections
2. append `om.reflections.recorded`, if non-empty, with `coversUpToId` set to the latest observation coverage marker
3. dropper input includes the new reflections
4. if dropper produces drops, append `om.observations.dropped`
5. drop entry `coversUpToId` is the earlier branch position of latest observation coverage and latest effective reflection coverage
6. same-turn reflections contribute effective reflection coverage through their own internal `coversUpToId`, not through the appended reflection entry id

If reflector produces no reflections but dropper runs, dropper uses the earlier branch position of latest observation coverage and latest existing reflection coverage. If there is no valid reflection coverage yet, dropper bootstraps to latest observation coverage.

### Projection model

Full ledger projection:

- fold observations, reflections, and drops through the target entry
- active observations = recorded observations minus tombstoned/dropped ids
- dropped observations remain recallable

Visible projection:

- represents what the agent currently sees from latest/current compaction summary
- normal folds keep reflection/drop effects stable from latest full-fold boundary
- normal folds continue adding observations up to current `firstKeptEntryId`
- full folds apply observations, reflections, and drops up to current `firstKeptEntryId`

`fullFold: false`:

- observations current through compaction boundary
- reflections and drops current only through latest prior full-fold boundary

`fullFold: true`:

- observations, reflections, and drops all current through compaction boundary
- establishes a new full-fold boundary

No `foldedThroughEntryId`, no `lastRefreshThroughEntryId`, no projection object in details.

## Target module layout

Initial V3 should be simple and explicit.

```text
src/session-ledger/
  types.ts
  progress.ts
  fold.ts
  projection.ts
  recall.ts
  index.ts

src/agents/
  run-agent.ts
  observer/
    agent.ts
    prompt.ts
  reflector/
    agent.ts
    prompt.ts
  dropper/
    agent.ts
    prompt.ts

src/hooks/
  memory-work-trigger.ts
  compaction-trigger.ts
  compaction-hook.ts

src/commands/
  status.ts
  view.ts

src/tools/
  recall-observation.ts
```

Avoid:

- generic event-sourcing framework
- repository/service classes
- dependency injection
- persisted indexes
- clever cache layers
- V2 migration/compatibility layer
- scheduler abstraction unless genuinely needed later

## Phase 0 — Preserve baseline and create V3 test foundation

### Purpose

Create a V3-only test suite. Do not restore old V2 tests as active tests.

### Files to create

```text
tests/fixtures/session.ts
tests/session-ledger-types.test.ts
tests/session-ledger-progress.test.ts
tests/session-ledger-fold.test.ts
tests/session-ledger-projection.test.ts
```

### Fixture requirements

`tests/fixtures/session.ts` should provide builders for:

```ts
rawMessage(id, content, overrides?)
customMessage(id, content, overrides?)
branchSummary(id, summary, overrides?)
compactionEntry(id, { firstKeptEntryId, details, summary? })
observationsRecordedEntry(id, data)
reflectionsRecordedEntry(id, data)
observationsDroppedEntry(id, data)
oldV2ObservationEntry(id, data)
oldV2CompactionDetails(...)
```

Fake contexts later:

- fake Pi append API
- fake session manager branch
- fake compaction context
- fake model registry
- fake UI notify if needed

### Initial tests

`session-ledger-types.test.ts`:

- accepts valid V3 observation entry data
- accepts valid V3 reflection entry data
- accepts valid V3 drop entry data
- accepts valid `MemoryDetails`
- rejects/ignores empty observation/reflection/drop entry data
- ignores old V2 `om.observation`
- ignores old V2 `"observational-memory"` details
- requires observation `sourceEntryIds`
- requires per-record `tokenCount`

`session-ledger-progress.test.ts`:

- no coverage marker counts raw tokens from branch root
- observation coverage counts raw tokens after observation marker
- reflection coverage counts raw tokens after reflection marker
- drop coverage counts raw tokens after drop marker
- latest inner `coversUpToId` marker can be retrieved for each memory entry type
- earlier coverage marker can be selected by branch index for combined-frontier dropper progress
- historical memory-entry markers remain tolerated, but new reflector/dropper writes should not use newly appended `om.*` entry ids as progress watermarks
- raw progress ignores memory custom entries
- raw progress ignores compaction entries
- invalid/missing coverage marker does not throw

`session-ledger-fold.test.ts`:

- folds observations root → target
- folds reflections root → target
- applies drops as tombstones
- dropped observations remain in history
- unknown drop ids do not throw
- old V2 entries ignored
- branch fork fixtures fold only current branch path

`session-ledger-projection.test.ts`:

- full projection includes observations/reflections/drops through target
- visible projection starts empty with no V3 compaction
- normal fold includes observations but keeps reflections/drops stable
- full fold includes observations/reflections/drops
- latest full-fold boundary controls normal fold
- visible/full drift is detectable

### Validation

```bash
npm test -- tests/session-ledger-types.test.ts tests/session-ledger-progress.test.ts tests/session-ledger-fold.test.ts tests/session-ledger-projection.test.ts
npm run typecheck
```

## Phase 1 — Add `src/session-ledger/types.ts`

### Purpose

Define V3 persisted data shapes, constants, guards, and non-empty builders.

### File

```text
src/session-ledger/types.ts
```

### Exports

```ts
export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_FOLDED = "om.folded";

export type Entry = {
  type: string;
  id: string;
  timestamp?: string;
  message?: unknown;
  content?: unknown;
  customType?: string;
  summary?: unknown;
  fromId?: string;
  data?: unknown;
  details?: unknown;
  firstKeptEntryId?: string;
};

export type Observation = { /* V3 observation shape */ };
export type Reflection = { /* V3 reflection shape */ };
export type ObservationsRecordedEntryData = { /* observations + coversUpToId */ };
export type ReflectionsRecordedEntryData = { /* reflections + coversUpToId */ };
export type ObservationsDroppedEntryData = { /* observationIds + coversUpToId */ };
export type MemoryDetails = { /* om.folded details */ };
```

### Guards

```ts
isObservation(value): value is Observation
isReflection(value): value is Reflection
isObservationsRecordedData(value): value is ObservationsRecordedEntryData
isReflectionsRecordedData(value): value is ReflectionsRecordedEntryData
isObservationsDroppedData(value): value is ObservationsDroppedEntryData
isMemoryDetails(value): value is MemoryDetails
isObservationsRecordedEntry(entry): boolean
isReflectionsRecordedEntry(entry): boolean
isObservationsDroppedEntry(entry): boolean
isMemoryCompactionEntry(entry): boolean
```

### Builder behavior

Builders should prevent empty ledger entries:

```ts
buildObservationsRecordedData(observations, coversUpToId): ObservationsRecordedEntryData | undefined
buildReflectionsRecordedData(reflections, coversUpToId): ReflectionsRecordedEntryData | undefined
buildObservationsDroppedData(observationIds, coversUpToId): ObservationsDroppedEntryData | undefined
```

If input arrays are empty, return `undefined`.

### Validation

```bash
npm test -- tests/session-ledger-types.test.ts
npm run typecheck
```

## Phase 2 — Add `src/session-ledger/progress.ts`

### Purpose

Centralize branch position and raw token progress logic.

### File

```text
src/session-ledger/progress.ts
```

### Responsibilities

- identify source entries
- map entry id → branch index
- resolve `coversUpToId` to branch position
- count raw/source tokens after a branch position
- compute independent coverage clocks
- compute raw tokens since last Pi compaction

### Source entry definition

```ts
type SourceEntryType = "message" | "custom_message" | "branch_summary";
```

Source entries:

- count toward raw token progress
- are serializable for observer input
- are valid observation provenance entries

Memory entries:

- may be `coversUpToId`
- do not count as raw source tokens

### Exports

```ts
isSourceEntry(entry: Entry): boolean
entryIndexById(entries: Entry[]): Map<string, number>
latestCoverageIndex(entries, customType): number
rawTokensAfterIndex(entries, index): number
rawTokensSinceObservationCoverage(entries): number
rawTokensSinceReflectionCoverage(entries): number
rawTokensSinceDropCoverage(entries): number
rawTokensSinceLastCompaction(entries): number
latestSourceEntryIdAtOrBefore(entries, index): string | undefined
latestBranchPositionId(entries): string | undefined
```

### Key semantics

Coverage helper:

1. scan valid entries of requested custom type
2. read `data.coversUpToId`
3. map to branch index
4. choose max valid branch index
5. count raw tokens after that index

If marker is missing or not found:

- ignore that marker
- do not throw in status/trigger paths

### Validation

```bash
npm test -- tests/session-ledger-progress.test.ts
npm run typecheck
```

## Phase 3 — Add `src/session-ledger/fold.ts`

### Purpose

Fold V3 ledger entries into memory truth.

### File

```text
src/session-ledger/fold.ts
```

### Exports

```ts
type FoldedLedger = {
  observations: Observation[];
  activeObservations: Observation[];
  droppedObservationIds: Set<string>;
  reflections: Reflection[];
  observationsById: Map<string, Observation>;
  reflectionsById: Map<string, Reflection>;
};

foldLedger(entries: Entry[], options?: { upToEntryId?: string }): FoldedLedger
```

### Semantics

Fold from branch root through `upToEntryId`, inclusive.

For `om.observations.recorded`:

- add observations
- dedupe by id
- recommended duplicate policy: first valid record wins, later duplicate ignored

For `om.reflections.recorded`:

- add reflections
- dedupe by id
- recommended duplicate policy: first valid record wins

For `om.observations.dropped`:

- add ids to tombstone set
- unknown ids do not throw
- tombstones remain even if id unknown at the time

Active observations:

- observations whose id is not tombstoned

Dropped observations:

- removed from agent-visible active pool
- remain in ledger history for recall

### Validation

```bash
npm test -- tests/session-ledger-fold.test.ts
npm run typecheck
```

## Phase 4 — Add `src/session-ledger/projection.ts`

### Purpose

Compute visible projection, full projection, drift, and compaction projection.

### File

```text
src/session-ledger/projection.ts
```

### Exports

```ts
type Projection = {
  observations: Observation[];
  reflections: Reflection[];
};

type ProjectionDiff = {
  observationsOnlyInFull: Observation[];
  reflectionsOnlyInFull: Reflection[];
  droppedOnlyInFull: Observation[];
};

fullProjection(entries: Entry[], upToEntryId?: string): Projection
visibleProjection(entries: Entry[], upToEntryId?: string): Projection
diffProjection(visible: Projection, full: Projection): ProjectionDiff
latestFullFoldBoundaryId(entries: Entry[]): string | undefined
buildCompactionProjection(entries, firstKeptEntryId, config): {
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
  details: MemoryDetails;
}
```

### Full projection

Fold all V3 ledger effects through target:

- observations
- reflections
- drops

### Visible projection

Default user/agent-visible memory.

For latest visible memory:

- use latest V3 `om.folded` compaction details if present
- if latest compaction details are old V2 or invalid, visible memory is empty

For building a new compaction:

- target boundary is Pi `firstKeptEntryId`
- normal fold:
  - observations through current `firstKeptEntryId`
  - reflections/drops through latest prior full-fold boundary
- full fold:
  - observations/reflections/drops through current `firstKeptEntryId`

### Full-fold boundary

Find latest compaction entry where:

- `entry.type === "compaction"`
- `entry.details.type === "om.folded"`
- `entry.details.fullFold === true`
- `entry.firstKeptEntryId` maps to branch entry

Use that `firstKeptEntryId` as reflection/drop boundary for future normal folds.

### Full-fold decision

Candidate normal projection:

- sum `tokenCount` of visible observations
- if `>= observationsPoolMaxTokens`, use `fullFold: true`
- otherwise `fullFold: false`

Open decision:

- confirm `>=` vs strict `>`; recommendation is `>=`

### Validation

```bash
npm test -- tests/session-ledger-projection.test.ts
npm run typecheck
```

## Phase 5 — Add `src/session-ledger/recall.ts`

### Purpose

Implement ledger-history recall independent of visible projection.

### File

```text
src/session-ledger/recall.ts
```

### Exports

```ts
type RecallResult =
  | { status: "not_found"; memoryId: string }
  | {
      status: "found";
      memoryId: string;
      kind: "observation" | "reflection";
      observations: RecalledObservation[];
      reflections: RecalledReflection[];
      sourceEntries: Entry[];
      missingSourceEntryIds: string[];
      nonSourceEntryIds: string[];
      partial: boolean;
    };

recallMemorySources(entries: Entry[], memoryId: string): RecallResult
```

### Observation recall

- find observation in `om.observations.recorded`
- check later drop tombstones
- mark active/dropped
- resolve `sourceEntryIds`
- preserve missing-source warnings

### Reflection recall

- find reflection in `om.reflections.recorded`
- resolve supporting observations through ledger history
- check whether supporting observations were later dropped
- resolve source entries for supporting observations
- mark partial when source/provenance is incomplete

### Validation

```bash
npm test -- tests/session-ledger-recall.test.ts
npm run typecheck
```

## Phase 6 — Replace compaction hook

### Purpose

Deliver the main product outcome: instant compaction.

### File

```text
src/hooks/compaction-hook.ts
```

### Required behavior

`session_before_compact` should:

1. read `event.preparation.firstKeptEntryId`
2. read `event.preparation.tokensBefore`
3. read branch entries
4. build V3 compaction projection
5. render deterministic summary
6. return Pi compaction payload with V3 `MemoryDetails`

Must not:

- call `runtime.resolveModel`
- await `runtime.observerPromise`
- await `runtime.reflectDropPromise`
- call observer
- call reflector
- call dropper
- append ledger entries
- do sync catch-up
- use progress widget for LLM work
- cancel because no V3 memory exists

### Empty memory compaction

If there is no V3 memory:

- return valid `MemoryDetails`
- observations `[]`
- reflections `[]`
- summary can say no observational memory recorded yet
- do not cancel

### Tests

`tests/compaction-hook.test.ts`:

- returns V3 details
- `fullFold: false` normal projection
- `fullFold: true` when pool pressure reached
- old V2 entries ignored
- no V3 memory still compacts
- `runtime.resolveModel` throws if called; test should still pass
- unresolved worker promises do not block compaction
- no observer/reflector/dropper calls

### Validation

```bash
npm test -- tests/session-ledger-projection.test.ts tests/compaction-hook.test.ts
npm run typecheck
```

## Phase 7 — Cut over config/runtime

### Purpose

Replace V2 config names with clean V3 settings.

### Files

```text
src/config.ts
src/runtime.ts
```

### Config shape

```ts
type Config = {
  observeAfterTokens: number;
  reflectAfterTokens: number;
  compactAfterTokens: number;
  observationsPoolMaxTokens: number;
  agentMaxTurns: number;
  model?: {
    provider: string;
    id: string;
    thinking?: ModelThinkingLevel;
  };
  passive: boolean;
  debugLog: boolean;
};
```

### Defaults

Recommended defaults:

- `observeAfterTokens: 1000`
- `reflectAfterTokens: 5000`
- `compactAfterTokens: 50000`
- `observationsPoolMaxTokens: 30000`
- `agentMaxTurns: 16`
- `passive: false`
- `debugLog: false`
- `model: undefined`
- `model.thinking: "low"` when model is configured and no thinking value supplied

### Env

Keep:

```text
PI_OBSERVATIONAL_MEMORY_PASSIVE
```

### No compatibility warnings

Old config keys are ignored:

- `observationThresholdTokens`
- `compactionThresholdTokens`
- `reflectionThresholdTokens`
- `compactionModel`
- `thinkingLevel`
- `observerMaxTurnsPerRun`
- `reflectorMaxTurnsPerPass`
- `prunerMaxTurnsPerPass`
- `compactionMaxToolCalls`

### Runtime state

```ts
observerInFlight: boolean
reflectDropInFlight: boolean
compactInFlight: boolean
compactHookInFlight: boolean

observerPromise?: Promise<void> | null
reflectDropPromise?: Promise<void> | null
lastObserverError?: string
lastReflectDropError?: string
```

Compaction must never await worker promises.

### Tests

`tests/config.test.ts`:

- defaults
- project/global/env precedence
- passive env override
- old keys ignored
- invalid values ignored or fallback to defaults
- no warning output

`tests/runtime.test.ts`:

- model resolution uses `config.model`
- separate observer vs reflect/drop in-flight flags
- launcher clears flags on success/failure
- compaction flags independent

### Validation

```bash
npm test -- tests/config.test.ts tests/runtime.test.ts
npm run typecheck
```

## Phase 8 — Update auto-compaction trigger

### Purpose

Keep automatic compaction, but remove worker waits and use V3 naming.

### File

```text
src/hooks/compaction-trigger.ts
```

### Behavior

Hook remains:

```ts
pi.on("agent_end", ...)
```

Skip when:

- `passive`
- `compactInFlight`
- final assistant ended with retryable provider/network error
- raw tail below `compactAfterTokens`
- context not idle after deferred check

Then:

- set `compactInFlight`
- `setTimeout(0)`
- re-check idle
- re-read branch
- re-check raw tail
- call `ctx.compact()`
- clear flag

Must not:

- await observer
- await reflector/dropper
- care whether memory work is behind

### Tests

`tests/compaction-trigger.test.ts`:

- below threshold does nothing
- above threshold calls compact
- retryable error skips
- passive skips
- in-flight skips
- idle re-check prevents compaction
- threshold re-check prevents duplicate compaction
- unresolved observer promise does not block
- unresolved reflect/drop promise does not block

### Validation

```bash
npm test -- tests/compaction-trigger.test.ts
npm run typecheck
```

## Phase 9 — Port observer

### Purpose

Convert observer from V2 `om.observation` producer to V3 `om.observations.recorded` producer.

### Files

Likely:

```text
src/hooks/memory-work-trigger.ts
src/agents/observer/agent.ts
src/agents/observer/prompt.ts
src/agents/run-agent.ts
```

May temporarily adapt:

```text
src/hooks/observer-trigger.ts
src/observer.ts
```

### Behavior

On `turn_end`:

1. ensure config
2. skip passive
3. skip if observer in flight
4. compute raw tokens after last observation coverage marker
5. if below `observeAfterTokens`, do not run observer
6. if due:
   - build raw/source range after last observation marker
   - serialize only source entries
   - include V3 memory context
   - run observer
   - validate required `sourceEntryIds`
   - compute per-observation `tokenCount` in code
   - dedupe by deterministic id
   - append `om.observations.recorded` only if non-empty
   - use `coversUpToId` as latest branch position included in decision snapshot
7. return; reflector/dropper never run same turn

### No-output behavior

If observer produces nothing:

- append nothing
- do not advance observation clock
- next due run observes a larger range
- no cap

### Tests

`tests/observer-trigger.test.ts`:

- below threshold no run
- due runs observer
- no-output appends nothing
- no-output leaves coverage unchanged
- appends V3 entry with non-empty observations
- computes per-observation token count
- required source ids validated
- old V2 entries ignored for prior memory
- observer priority prevents reflect/drop same turn

`tests/observer.test.ts`:

- agent tool schema validation
- rejects invented source ids
- dedupes deterministic ids
- returns undefined/empty when no tool call
- computes tokenCount outside LLM

### Validation

```bash
npm test -- tests/observer.test.ts tests/observer-trigger.test.ts
npm run typecheck
```

## Phase 10 — Port reflector/dropper

### Purpose

Move reflection and dropping out of compaction and into continuous background memory work.

### Files

```text
src/hooks/memory-work-trigger.ts
src/agents/reflector/agent.ts
src/agents/reflector/prompt.ts
src/agents/dropper/agent.ts
src/agents/dropper/prompt.ts
```

Delete/replace later:

```text
src/compaction.ts
```

### Trigger behavior

Only checked when observer does not run.

Compute:

```ts
reflectorDue = rawTokensSinceReflectionCoverage(entries) >= reflectAfterTokens;
dropperDue = rawTokensSinceDropCoverage(entries) >= reflectAfterTokens;
```

Cases:

- neither due: do nothing
- reflector only: run reflector
- dropper only: run dropper
- both: run reflector then dropper

### Reflector behavior

Input:

- full ledger projection or chosen memory context
- active observations
- existing reflections

Output:

- new reflections
- required `supportingObservationIds`
- one-line prose
- code-computed `tokenCount`

Append:

- `om.reflections.recorded`
- only if non-empty
- `coversUpToId` = latest branch position in reflector decision snapshot

### Dropper behavior

Input:

- active observations
- reflections
- if same invocation reflector produced new reflections, include them

Output:

- observation ids to drop
- only active observation ids should be accepted
- dedupe ids

Append:

- `om.observations.dropped`
- only if non-empty
- `coversUpToId` = earlier branch position of latest observation coverage and latest effective reflection coverage
- if based on same-turn reflections, those reflections contribute effective reflection coverage through their own internal `coversUpToId`, not through the appended reflection entry id
- if no valid reflection coverage exists yet, bootstrap `coversUpToId` to latest observation coverage

### Failure semantics

Recommended:

- if reflector fails and dropper was also due, skip dropper for that turn
- if reflector succeeds and dropper fails, keep/appended reflection entry; dropper retries later
- if dropper produces invalid ids only, append nothing and do not advance drop clock

### Tests

`tests/reflect-drop-trigger.test.ts`:

- neither due
- reflector only due
- dropper only due
- both due: reflector first
- dropper sees same-turn new reflections
- reflection append before drop append
- reflector coverage uses latest observation coverage, not branch leaf
- dropper coverage uses the earlier branch position of latest observation coverage and latest effective reflection coverage
- same-turn drop coverage uses the reflection entry's internal `coversUpToId`, not the appended reflection entry id
- no-output reflector appends nothing
- no-output dropper appends nothing
- failed reflector skips dropper when both due
- failed dropper does not roll back reflection append

`tests/reflector.test.ts`:

- validates supporting ids
- computes tokenCount
- no-output behavior
- dedupe

`tests/dropper.test.ts`:

- accepts only active observation ids
- ignores invalid/unknown ids
- no-output behavior
- dedupe

### Validation

```bash
npm test -- tests/reflector.test.ts tests/dropper.test.ts tests/reflect-drop-trigger.test.ts
npm run typecheck
```

## Phase 11 — Update `/om-view`

### Purpose

Replace V2 committed/pending language with V3 visible/full/diff.

### File

```text
src/commands/view.ts
```

### Modes

```text
/om-view
/om-view full
/om-view diff
```

Default:

- show visible projection
- what agent currently sees from latest compaction projection

Full:

- fold full ledger to branch tip
- show true active observations/reflections
- include effects not yet visible

Diff:

- compare visible vs full
- show drift:
  - observations only in full
  - reflections only in full
  - dropped observations still visible until next full fold

### Tests

`tests/view-command.test.ts`:

- default visible projection
- full projection
- diff projection
- old V2 details show clean V3 visible memory
- no memory output
- formatting includes ids and counts

### Validation

```bash
npm test -- tests/view-command.test.ts
npm run typecheck
```

## Phase 12 — Update `/om-status`

### Purpose

Expose memory health and next actions without becoming noisy.

### File

```text
src/commands/status.ts
```

### Should show

- ledger entry counts
- active observation count/token sum
- dropped observation count
- reflection count/token sum
- latest compaction state
- latest fullFold status
- visible vs full drift summary
- next observation progress vs `observeAfterTokens`
- next reflection progress vs `reflectAfterTokens`
- next drop progress vs `reflectAfterTokens`
- next auto-compaction progress vs `compactAfterTokens`
- visible observation pool vs `observationsPoolMaxTokens`
- worker in-flight flags
- passive mode
- last error/skipped reason if available

### Keep concise

Deep ledger diagnostics belong in:

- `/om-view full`
- `/om-view diff`

### Tests

`tests/status-command.test.ts`:

- no memory status
- visible/full drift status
- separate reflection/drop progress
- auto-compaction progress
- worker flags
- passive mode
- old V2 entries ignored

### Validation

```bash
npm test -- tests/status-command.test.ts
npm run typecheck
```

## Phase 13 — Update recall tool

### Purpose

Keep recall UX while replacing backend with ledger-history lookup.

### File

```text
src/tools/recall-observation.ts
```

### Preserve

- tool name: `recall`
- input shape: `{ id }`
- source excerpt rendering style
- TUI rendering style
- missing-source warnings where still relevant

### Replace backend

Use:

```text
src/session-ledger/recall.ts
```

Observation recall:

- find observation in ledger history
- mark active or dropped
- resolve source entries
- dropped observations remain recallable

Reflection recall:

- find reflection in ledger history
- resolve supporting observations
- mark supporting observations active/dropped
- render exact source excerpts

Remove V2 concepts:

- legacy reflection promotion
- `no_provenance` as a V2 concept, unless kept only as a generic missing-source status

### Tests

`tests/session-ledger-recall.test.ts`:

- active observation
- dropped observation
- reflection with supporting observations
- supporting observation dropped later
- missing source entry
- invalid id
- not found
- old V2 ignored

`tests/recall-tool.test.ts`:

- preserves tool name
- renders active observation
- renders dropped observation
- renders reflection
- missing-source warning
- invalid id
- not found

### Validation

```bash
npm test -- tests/session-ledger-recall.test.ts tests/recall-tool.test.ts
npm run typecheck
```

## Phase 14 — Delete V2 code

### Purpose

Remove obsolete implementation after V3 callers are migrated.

### Candidates for deletion or major simplification

```text
src/types.ts
src/branch.ts
src/compaction.ts
src/observer.ts
src/hooks/observer-trigger.ts
```

Only delete after verifying no imports remain.

### Remove concepts

- `OBSERVATION_CUSTOM_TYPE = "om.observation"`
- `ObservationEntryData.records`
- `coversFromId`
- entry-level `tokenCount`
- `MemoryDetailsV3`
- `MemoryDetailsV4`
- `type: "observational-memory"`
- `legacy` reflections
- `migrateLegacyReflections`
- committed/pending memory state
- compaction-time observer catch-up
- compaction-time reflector/pruner
- `pruner` naming where user-facing/internal V3 should say dropper
- old config aliases
- deprecated turn-limit fields

### Validation

```bash
grep -R "om.observation\|observational-memory\|MemoryDetailsV4\|coversFromId\|legacy\|pruner\|compactionModel\|thinkingLevel\|observationThresholdTokens\|compactionThresholdTokens\|reflectionThresholdTokens" -n src tests
npm test
npm run typecheck
```

Some strings may remain in tests that assert old V2 data is ignored. Those should be intentional.

## Phase 15 — Full validation and manual Pi smoke

### Automated validation

```bash
npm test
npm run typecheck
```

### Manual smoke

In a Pi dev session with the extension:

1. Start session with clean V3 memory.
2. Accumulate enough raw tokens to trigger observer.
3. Verify `om.observations.recorded` ledger entry appears.
4. Run `/om-status`.
5. Run `/om-view`.
6. Run `/om-view full`.
7. Run `/om-view diff`.
8. Accumulate enough raw tokens for reflector/dropper.
9. Verify independent reflection/drop progress.
10. Force/manual compact.
11. Verify compaction is instant.
12. Verify compaction does not wait on active worker.
13. Recall an active observation.
14. Recall a dropped observation.
15. Recall a reflection.
16. Open old V2-started session and verify:
    - no crash
    - old V2 memory ignored
    - first V3 compaction replaces visible old summary

### Release readiness checks

Before declaring V3 ready:

- compaction hook has no LLM/model call path
- no background worker awaits in compaction trigger/hook
- no V2 migration code
- no empty ledger entries possible through builders
- commands use shared projection helpers
- recall uses ledger history
- tests cover projection drift and fullFold behavior

## Suggested implementation order summary

1. V3 test fixtures and first ledger tests
2. `src/session-ledger/types.ts`
3. `src/session-ledger/progress.ts`
4. `src/session-ledger/fold.ts`
5. `src/session-ledger/projection.ts`
6. `src/session-ledger/recall.ts`
7. V3 summary renderer
8. model-free compaction hook
9. V3 config/runtime
10. auto-compaction trigger
11. observer producer
12. reflector/dropper producers
13. `/om-view`
14. `/om-status`
15. recall tool
16. V2 cleanup
17. full validation and manual Pi smoke

## Open decisions

### `observationsPoolMaxTokens` threshold

Recommendation: use `>=`.

Reason:

- consistent with other threshold checks
- easier to reason about
- avoids one-token ambiguity

### Duplicate ids

Recommendation: first valid record wins.

Reason:

- deterministic
- avoids later entries mutating historical facts
- aligns with append-only ledger simplicity

### Unknown drop ids

Recommendation: retain tombstones by id, but they only affect observations if that id exists in folded history.

Reason:

- deterministic folding
- safe if drop appears before observation due branch/order oddity
- no throw in user-facing flows

### Invalid `coversUpToId`

Recommendation:

- builder should try to produce valid branch position ids
- progress helpers should ignore invalid markers rather than throw

Reason:

- avoids old/malformed sessions breaking `/om-status` or triggers
- valid V3 producers should still be tested strictly

### `/om-view diff` first milestone

Recommendation:

- implement after visible/full are correct
- can be deferred if scope tightens

Reason:

- useful diagnostics
- not required for instant compaction

## Highest risks

### Accidentally preserving V2 compaction behavior

Any of these in `session_before_compact` breaks V3:

- model resolution
- API key resolution
- observer wait
- sync catch-up observer
- reflector/dropper
- progress widget around LLM work

Mitigation:

- explicit negative tests
- replace compaction hook wholesale

### Projection bugs

Visible vs full projection is subtle:

- normal fold updates observations only
- full fold applies reflections/drops
- latest full-fold boundary matters
- dropped observations remain recallable

Mitigation:

- dense pure tests before hook changes
- commands/compaction/recall share `session-ledger` helpers

### No-output retry cost

No empty entries means no-output agents retry later over larger ranges.

Mitigation:

- accepted product behavior
- no cap
- expose progress in `/om-status`
- consider runtime-only backoff later only if needed, not ledger entries

### Same-turn reflector/dropper coupling

Dropper must see new reflections, but `coversUpToId` remains a progress watermark. Same-turn reflections contribute effective reflection coverage through their own internal `coversUpToId`; the drop entry should not use the appended reflection ledger entry id as its marker.

Mitigation:

- one sequential reflect/drop worker lane
- append reflection before drop
- pass same-turn reflections into dropper input
- tests verify drop coverage uses the reflection entry's internal `coversUpToId`, not the appended reflection entry id

### Old V2 session confusion

Old V2 memory is ignored by V3, but old visible compaction summary text may remain until new V3 compaction.

Mitigation:

- first V3 compaction returns clean `om.folded` details
- no warning required
- manual smoke old session

## Non-goals

- V2 migration
- V2 compatibility aliases
- compatibility warnings
- restoring V2 tests as active suite
- compaction-time memory synthesis
- generic event-sourcing framework
- persisted indexes
- deep scheduler abstraction
- empty no-op ledger progress entries

# @sovorn/pi-observational-memory

- **npm:** https://www.npmjs.com/package/@sovorn/pi-observational-memory
- **Pi package:** https://pi.dev/packages/@sovorn/pi-observational-memory
- **License:** MIT

A Pi extension that keeps long-running conversations coherent across compaction. It records useful observations, distills durable reflections, removes redundant active observations when safe, and feeds bounded memory back into Pi's next context window.

This package is designed to be installed and used on its own. You do not need to install or read another repository.

## Quick start

Install it through Pi:

```bash
pi install npm:@sovorn/pi-observational-memory
```

Restart Pi after installation. The extension starts automatically with its defaults.

Check its state inside Pi:

```text
/om:status
```

View recorded memory:

```text
/om:view
```

Update it later through Pi:

```bash
pi update npm:@sovorn/pi-observational-memory
```

Or update all installed Pi packages:

```bash
pi update --extensions
```

The npm package does not have a separate update CLI. Installation and updates are managed by Pi.

## What it does

Long Pi sessions eventually need compaction: older conversation is removed from the active context and replaced with a shorter summary. Without memory support, important decisions, constraints, and user preferences can disappear during repeated compactions.

This extension prepares memory continuously:

1. **Observer** — reads new conversation content and records timestamped observations such as decisions, progress, constraints, completed work, and blockers.
2. **Reflector** — turns durable observations into long-lived reflections such as user preferences, project goals, technical decisions, rationale, and invariants.
3. **Dropper** — when the active observation pool is too large and reflection coverage exists, removes observations that are safe to treat as redundant. The ledger history is retained.
4. **Compaction** — supplies observations and reflections to Pi when the context is compacted.
5. **Recall** — memory entries have IDs so exact source evidence can be recovered when a compressed memory needs verification.

Normal observation and reflection recording continues to use its own background thresholds. This fork additionally limits how many reflection tokens are sent back into Pi during compaction.

## Reflection context control

The full reflection ledger is retained. Only the reflection representation sent into the active context is bounded.

```text
full reflection ledger
        |
        +-- older reflections -> rolling digest
        +-- newest reflections -> kept verbatim
        |
        +-- digest + recent reflections -> Pi context
```

The default reflection context budget is `10,000` tokens:

- 40% for a digest of older reflections
- 60% for the newest reflections kept verbatim

When the recent window overflows, the older portion is folded into a replacement digest. The digest stores a watermark so later compactions do not summarize the entire history again. Original reflections are never deleted.

The digest uses the same model configured for the other memory workers. If no model is available, a bounded fallback prevents the compaction context from growing without limit.

## Configuration

Settings go under the `observational-memory` key in either:

- Global: `~/.pi/agent/settings.json`
- Project-local: `<project>/.pi/settings.json`

Project settings override global settings. Restart Pi after changing settings.

### Minimal useful configuration

Most users only need this:

```json
{
  "observational-memory": {
    "reflectionContextMaxTokens": 10000
  }
}
```

### Complete configuration

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "reflectionContextMaxTokens": 10000,
    "compactAfterTokens": 81000,
    "compactAfterTokensMode": "calibrated",
    "compactAfterTokensRatio": 0.68,
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "agentMaxTurns": 16,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "passive": false,
    "debugLog": false
  }
}
```

### Settings reference

| Setting | Default | What it controls |
|---|---:|---|
| `observeAfterTokens` | `10000` | How much new raw conversation accumulates before the observer runs. |
| `reflectAfterTokens` | `20000` | How much new raw conversation accumulates before the reflector runs. |
| `reflectionContextMaxTokens` | `10000` | Maximum reflection context sent into Pi during compaction. Internally split 40% digest and 60% recent reflections. |
| `compactAfterTokens` | `81000` | Proactive compaction threshold in calibrated mode. |
| `compactAfterTokensMode` | `"calibrated"` | Use `"calibrated"` for the fixed threshold or `"ratio"` to scale it to the model context window. |
| `compactAfterTokensRatio` | `0.68` | Context-window ratio used only in `"ratio"` mode. Must be between `0` and `1`. |
| `observationsPoolMaxTokens` | `20000` | Observation size at which full-fold/drop maintenance becomes relevant. |
| `observationsPoolTargetTokens` | `10000` | Target size for the active observation pool after maintenance. |
| `agentMaxTurns` | `16` | Maximum turns for observer, reflector, and dropper background workers. |
| `model` | session model | Optional model override with `provider`, `id`, and optional `thinking`. |
| `passive` | `false` | Set to `true` to disable proactive background memory and auto-compaction triggers. |
| `debugLog` | `false` | Enable local diagnostic logs under the Pi agent directory. |

### Which settings should I change?

- Want tighter context after compaction? Lower `reflectionContextMaxTokens`.
- Want more historical reflection detail? Increase `reflectionContextMaxTokens`.
- Want memory workers to run more often? Lower `observeAfterTokens` or `reflectAfterTokens`.
- Want fewer background model calls? Increase those thresholds.
- Want a cheaper memory model? Set `model`.
- Want to disable automatic background work? Set `passive` to `true`.

The normal reflection ledger is not limited by `reflectionContextMaxTokens`; that setting limits only what is fed back into the active Pi context.

## Model configuration

If `model` is omitted, observer, reflector, dropper, and reflection-digest maintenance use the current Pi session model.

To use a dedicated memory model:

```json
{
  "observational-memory": {
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    }
  }
}
```

The provider and model must already be available in Pi's model registry and have a usable API key.

## Inspecting and troubleshooting

Inside Pi:

```text
/om:status
/om:view
```

When `debugLog` is enabled, diagnostic files are written below:

```text
~/.pi/agent/observational-memory/debug/
```

Memory entries shown in summaries have IDs. Use the `recall` tool with a specific ID when exact source context is needed; recall is intentionally not a broad memory search.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Credits

The underlying observational-memory architecture is based on [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory). This package adds bounded reflection-context handling while retaining the upstream observer, reflector, dropper, ledger, and recall design.

The upstream project and its contributors retain credit for the original implementation. This package is distributed under the MIT License; see [LICENSE](./LICENSE).

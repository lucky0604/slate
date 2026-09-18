# Phase 1C — Provider-neutral Generation Identity & Submission

> Status: Implemented (test-proven). Short implementation note — not a rewrite of
> the main architecture audit.

## Finding

Phase 1B left generation *submission* coupled to the active provider: a release
task was introduced; but the submission entry (`submitEffectGeneration`) resolved the
target via `effectId` and — when no provider was supplied — the active
provider's model bindings. So the provider registry could hold multiple providers
while the submit layer still implicitly expected "the active provider" to own a
logical model. That is not the Slate long-term model (`LLM → DeepSeek`,
`Image → OpenAI`, `Video → SGLang`), where the *explicit request* must decide who
runs a generation — not a global switch.

Two existing pieces already approximated a provider-neutral identity:

- `GenerationProviderModelBinding` already binds `logical modelId → effectId
  (provider-private ref) → upstreamModelId`. It was never re-created.
- `input._provider = { id, modelId, upstreamModelId, effectId }` was already
  written into the stored submission input, so `syncGeneration` could recover
  the true provider without the active provider.

What was missing was an explicit, provider-scoped *submission* identity: honoring
`providerId + modelId` over the active provider, failing fast on an unknown
provider / unsupported model for that provider, and persisting provider/model as
first-class history identity.

## Identity model before

```text
request (effectId)
  → getEffectById(effectId)            // providerId defaults to ACTIVE provider
  → active provider model binding
  → adapter
```

Active provider was the implicit, single identity source of every submission.

## Identity model after

```text
request
  ├─ providerId + modelId  (preferred, provider-neutral)
  └─ effectId              (legacy, BeatAPI-compatible)
        ↓
resolveGenerationSubmissionTarget      // one explicit (provider, logical model)
  providerId → registry → model binding → upstream ref
        ↓
submitEffectGeneration → recordGeneration → adapter (from that provider)
```

When `providerId` is absent the target is still resolved through the active
provider, but that is now the *legacy compatibility boundary*, not the primary
identity. It is tagged (`fromLegacyActiveProvider`) in the provenance and kept to
one place.

## Schema changes

Additive migration `0004_provider_neutral_generation`:

```text
ALTER TABLE generation_history ADD provider_id text;
ALTER TABLE generation_history ADD model_id text;
```

- `effect_id` is **kept** (provider-private numeric reference + legacy index).
- `provider_id` / `model_id` are nullable; rows written before Phase 1C read
  their identity from the existing `input._provider` provenance blob.
- New rows are written with both columns at submit time, so a history row answers
  "which provider + which logical model" without the active provider.
- No columns dropped; old rows remain valid and readable.

## effectId status

`effectId` remains the provider-private upstream numeric reference and the
BeatAPI submission/DB index key. It is no longer the *only* way to express a
submission — `providerId + modelId` is — and it no longer implies the provider
(the provider is now explicit or recovered from `_provider`/`provider_id`). It
serves as: provider-private metadata, historical provenance, and legacy
compatibility. It is **not** Slate's core domain identity.

## modelId / providerModelRef semantics

- `providerId` — which provider executes the generation (`beatapi`,
  `completion-test`, forks add their own). Explicit submission channel.
- `modelId` — Slate's stable logical model id (`gpt-image-2`, `minimax-h3`, …),
  unique *within* a provider. Several providers may offer the same logical
  `modelId` (e.g. future `minimax-h3` on both BeatAPI and SGLang); the explicit
  `providerId` selects which one.
- `providerModelRef` — no new standalone field. `GenerationProviderModelBinding`
  already carries the upstream reference (`binding.upstreamModelId`) and the
  provider-private numeric `effectId`. These stay inside the provider/binding
  layer, so the domain never sees BeatAPI numeric ids or upstream model strings.

## ACTIVE provider status

`ACTIVE_GENERATION_PROVIDER_ID` remains, and keeps its legitimate uses:

- UI model catalog / model picker (`workspace-models`, `effect-registry`,
  `model-catalog.listGenerationModelDescriptors`).
- Legacy submission fallback when a request carries no explicit `providerId`
  (`resolveGenerationSubmissionTarget`), now explicitly tagged as legacy.

It is **no longer** the sole identity of an explicit generation submission. A
request that provides `providerId` resolves solely from that provider.

## Tests added

`src/core/effects/provider-neutral-submission.test.ts` (test-only providers
`provider-a` / `provider-b`):

| Scenario | Result |
| -------- | ------ |
| explicit provider A + model-a | A invoked, B not |
| explicit provider B + model-b (active = A) | B invoked |
| active = A, explicit = B (shared modelId) | B |
| unknown provider | 422, no fallback, no adapter |
| model only on provider B, requested on A | validation error, no cross-routing |
| provider-specific upstream binding | A's ref resolved, not B's |
| legacy request (no providerId) | resolves via active provider, tagged legacy |
| history identity | provider_id / model_id persisted, readable without active |
| shared modelId across providers | allowed (unique within provider) |

Completion lifecycle and BeatAPI polling regression are covered by the unchanged
`completion-provider-lifecycle.test.ts` and BeatAPI adapter suites.

## Out of scope (unchanged)

No H3 / SGLang / OpenAI / Qwen integration. No Drama Domain. No Canvas / Timeline
schema or business changes. No Command Registry / MCP command-bus refactor. No
Generation lifecycle / execution-model refactor (polling, completion, and
asset-first paths are untouched).
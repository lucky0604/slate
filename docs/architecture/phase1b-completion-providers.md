# Phase 1B — Generation Execution Model: completion providers run on the existing lifecycle

> Status: Implemented (test-proven). Short implementation note — not a rewrite of the
> main architecture audit.

## Finding

**The existing Generation lifecycle already supports completion / immediate-result
providers.** No task-oriented assumption forces a completion provider to fabricate a
remote task id, a status endpoint, or polling.

Evidence in the shared orchestration:

- `BaseAdapter.checkStatus` is **optional** (`checkStatus?`), so a provider can
  simply omit it.
- `createGeneration` may return `GenerationResult.status === 'succeeded'` directly.
- `resolveGenerationSubmitTransition` resolves `succeeded` to the public `succeeded`
  state without any provider task id (`generation-orchestrator.ts`).
- `generation_history.provider_task_id` is **nullable**; `deriveGenerationOperationalFields`
  stores `null` when the output has no task id.
- `submit-generation.ts` only starts `startBackendPollingForGeneration` when the
  resolved public status is `pending` or `processing`; a `succeeded` result never
  schedules polling and persists output through `persistEffectOutputIfNeeded` on the
  submit path.
- `syncGeneration` short-circuits terminal generations and generations without a
  `providerTaskId` before ever calling `checkStatus`.

The shared boundary that carries execution behavior is the returned `status` plus
whether the adapter implements the optional `checkStatus` — not the provider name.

## What was added

- `src/core/generation-providers/completion-test-provider.ts` — a **test-only**
  completion provider (`id: 'completion-test'`). It is not registered in
  `src/config/generation-providers.ts`, is not surfaced in the catalog / model
  picker, and is registered only through the test/DI seam
  (`registerGenerationProvider`). Its adapter returns `succeeded` immediately with a
  `media.example.test` output URL, carries no `checkStatus`, and produces no remote
  task id.
- `src/core/effects/completion-provider-lifecycle.test.ts` — proves the full
  completion lifecycle (`createGeneration → succeeded → persistEffectOutputIfNeeded →
  recordUserAsset → generation_asset_link`) plus no-polling, no-checkStatus,
  allowlist acceptance/rejection, immediate-failure, and the BeatAPI polling /
  allowlist regression.

## Non-goal recorded for Phase 1C

`submitEffectGeneration` resolves the effect via the **active** provider
(`getEffectById` → active provider's model bindings), so submission is implicitly
single-active-provider at the HTTP layer. That is the active-provider product model,
not a completion-vs-task blockage. Provider-neutral *submission* identity/schema
(native `providerId + providerModelRef`, effectId neutralization) remains a Phase 1C
follow-up. `effectId` was not changed in this phase.
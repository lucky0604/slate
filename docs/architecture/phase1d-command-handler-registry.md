# Phase 1D — Declarative Command Handler Registry

> Status: Implemented (test-proven). Short implementation note — not a rewrite of
> the main architecture audit.

## Before

Command execution was a **closed union + central switch**. A new command type
required editing the dispatcher itself:

```text
Command
  → closed union (BeatDesignCommand)
  → executeBeatDesignCommand (executor.ts central switch on command.type)
  → applyCanvasOperations / applyEditorOperations / replace / validate
```

The persistence layer carried a parallel hard-coded document-target dispatch:

```text
persistBeatDesignCommandOnce
  → if (type === 'canvas.apply') load+save project snapshot
  → else load+save timeline (with editor.validate as a special no-write case)
```

Adding a future `drama.*` (or any new) command therefore meant growing the
`BeatDesignCommand` union, the executor switch, and the persist branch
simultaneously — the "不断膨胀的中央分发器" problem the audit flagged.

## After

Execution is dispatched through a **command handler registry** keyed by an open
`commandType` string:

```text
Command Envelope
  → commandType
  → Command Handler Registry
  → registered handler
  → existing pure application logic (applyCanvasOperations, applyEditorOperations, …)
```

```text
commandType → registered handler → schema (payload validation)
                                        → target ('canvas' | 'timeline')
                                        → persist (write vs validate-only)
                                        → execute (existing pure function)
```

A new command type is added by authoring a handler and registering it — **no
central executor switch or union edit required**.

## Handler contract

```ts
type CommandDocumentTarget = 'canvas' | 'timeline';

type CommandExecutionContext = {
  commandId: string;
  projectId: string;
  origin: 'ui' | 'mcp' | 'cli' | 'system';
  documents: BeatDesignCommandDocuments;
};

type CommandExecutionResult = { changedIds: string[]; data: BeatDesignCommandData };

type CommandHandler<TSchema extends z.ZodType> = {
  commandType: string;
  schema: TSchema;                 // command-specific payload schema
  target: CommandDocumentTarget;   // authoritative document the persistence loads/saves
  persist: boolean;                // whether the command writes a new revision
  execute(context, payload): CommandExecutionResult;
};
```

`CommandRegistry` responsibilities are intentionally narrow: `commandType → handler`,
duplicate registration fails fast, `get`/`resolve` on an unknown type fails
deterministically, and `execute` parses the payload through `handler.schema` then
delegates to `handler.execute`. Authorization, undo, MCP generation, OpenAPI, UI
form generation, event sourcing, observability, and workflow orchestration are
**not** part of the registry.

## Registration strategy

- `CommandRegistry` (open, generic `string` command types) in
  `src/core/commands/registry.ts`, with a `createCommandRegistry()` factory for
  isolated/test registries.
- The production `commandRegistry` singleton is constructed and pre-populated in
  `executor.ts`, wired from `handlers/*`. It is the default path both the
  executor and the persistence layer consult.
- Duplicate registration throws; unknown resolution throws. No override /
  provider-style shadowing.
- The old `BeatDesignCommand` union and `beatDesignCommandSchema` transport union
  **remain** as compatibility/type surface. `beatDesignCommandSchema` stays the
  strict UI/MCP wire contract; handler schemas describe the internal payload the
  existing pure functions consume.
- Test-only commands register into an **isolated** `createCommandRegistry()`;
  they never enter the production catalog.

## Preserved invariants

| Invariant | How it is preserved |
| --------- | ------------------- |
| Idempotency | `persistBeatDesignCommand` unchanged: `inFlightCommands` lock + receipt dedup. |
| CAS / revision | `saveProjectSnapshot` / `saveProjectTimeline` `baseVersion` unchanged; `expectedRevision` honored. |
| Conflict retry | `persistExternalCommandWithConflictRetry` unchanged; reuse existing `conflict-retry.ts` — no new registry retry. |
| Receipts | `storeCommandReceipt` → `project_command_receipt` unchanged. |
| Origin | Envelope `origin` threads through unchanged; transport still assigns `ui`/'mcp'/'cli'/'system'. |
| Persistence | `persistBeatDesignCommand` remains the single durable write entrypoint for both UI and MCP. |

The persistence mechanism is **not** moved into handlers. Handlers only declare
`target`/`persist` metadata; `persist.ts` uses it to route document load/save, so
the existing reliability layer is untouched.

## Scope verification

- No Drama commands.
- No H3 / SGLang / Provider refactor (Phase 1A–1C Provider Foundation untouched).
- No Canvas schema / Canvas card union changes.
- No Timeline schema changes.
- No MCP auto-generation from the registry (Phase 1E, deferred).
- No Application API rewrite.
- No Agent undo / op-log / checkpoint.
- No branding rename (`BeatDesignCommand`, `persistBeatDesignCommand` retained).

## Tests

`src/core/commands/command-handler-registry.test.ts` covers: Canvas registry
execution vs pure output, Editor registry execution, all production command types
registered, unknown command deterministic failure, duplicate registration fail
fast, `test.echo` extension command running without touching the executor, and
NOT_FOUND / receipt-shape / MCP-origin regressions. Idempotency, CAS/conflict
retry, and MCP origin regressions are additionally covered by the existing
`conflict-retry.test.ts` and `src/mcp/server.runtime.test.ts` suites (unchanged).

## Deferred work

Recorded so 1D is not mistaken for having solved these:

- Drama / Story / Scene / Shot / Character commands.
- MCP tool registration auto-generated from the registry (Phase 1E).
- Application API / SDK exposing the command registry.
- Project / Asset / Generation commands routed through the registry.
- Agent op-log / checkpoint and Agent undo.
- Row-level Drama domain revisions (relation tables).
- Event sourcing / observability / workflow orchestration on commands.
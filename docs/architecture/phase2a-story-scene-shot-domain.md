# Phase 2A — Slate Story / Scene / Shot Domain

> Status: Implemented (test-proven). This is the first Slate-owned product Domain
> layer, built on the frozen Foundation (Phase 1A–1D + P1 fix). It is a short
> implementation note, not a rewrite of the architecture audit.

## Domain entities

Phase 2A establishes exactly three relational entities:

```text
Project
   │
   ▼
Story        (belongs to a project)
   │
   ▼
Scene        (belongs to a story)
   │
   ▼
Shot         (belongs to a scene)
```

- **Story**: `id, projectId, title, premise?, revision, createdAt, updatedAt`
- **Scene**: `id, storyId, position, title, summary?, revision, createdAt, updatedAt`
- **Shot**: `id, sceneId, position, description, durationMs?, revision, createdAt, updatedAt`

No Character, Episode, Dialogue, Capability, language, aspect-ratio, or
provider/asset/generation/canvas/timeline fields are added in this phase.

## Relations

`stories.project_id → project.id` (ON DELETE CASCADE), `scenes.story_id →
stories.id` (CASCADE), `shots.scene_id → scenes.id` (CASCADE).

Indexes:

```text
stories(project_id)
stories(project_id, updated_at)
scenes(story_id)
scenes(story_id, position)
shots(scene_id)
shots(scene_id, position)
```

Position is a plain integer order (0-based) with a non-unique index for search.
Intentional reorder is supported only via single-row `scene.update(position)` /
`shot.update(position)`; bulk reorder / fractional ordering are deferred and
never assumed.

## Source-of-truth boundary

Story / Scene / Shot are the **domain source of truth**, stored in relational
tables. They are *not* Canvas cards, *not* a Timeline clip, and *not* a third
project document snapshot. Canvas remains a projection; Timeline remains final
assembly; Asset remains immutable media; Provider remains execution detail.

## Revision / concurrency model

Every domain row carries:

```text
revision INTEGER NOT NULL DEFAULT 1
```

Document CAS does not apply to relational rows. Domain updates use
**row-level optimistic concurrency**:

```text
UPDATE ... SET title = ?, revision = revision + 1
WHERE id = ? AND project/parent ownership AND revision = expectedRevision
```

An `update*` service reads the current row up-front (scoped through the project
parent chain) and throws `NOT_FOUND` if it is absent. It then issues the CAS
row update scoped by `id + ownership + expectedRevision`; a zero affected-rows
result means the precondition failed, and because existence was already
confirmed by the up-front read, the only remaining cause is a stale revision:

- `NOT_FOUND` — handled by the up-front, project-scoped existence read;
- `REVISION_CONFLICT` — the row exists but its current revision differs from
  `expectedRevision` (the CAS update affected zero rows).

Stale writes are **never silent**. `*.create` does not require
`expectedRevision`.

## Command integration

Six domain commands are registered into the **production command registry**
(`src/core/commands/executor.ts`), sharing the Foundation receipt / idempotency
path:

```text
story.create      story.update
scene.create      scene.update
shot.create       shot.update
```

The registry `CommandHandler` contract gained a `persistence` discriminant:

```text
{ kind: 'document'; target: 'canvas' | 'timeline'; write: boolean }  (existing)
{ kind: 'domain' }                                                    (new)
```

The command kernel only knows a domain command is relational; it never learns
the Story/Scene/Shot tables. The four built-in handlers
(`canvas.apply` / `editor.apply` / `editor.replace_document` / `editor.validate`)
are behaviour-identical, now declared through `persistence.kind === 'document'`.

Domain handlers are dispatched through a new async registry path and persisted
through the same durable receipt table (`project_command_receipt`). Repeating a
command id creates exactly one row (idempotency preserved).

## Domain persistence boundary

`src/core/story/`:

```text
contracts.ts    DomainWriteResult { entityType, entityId, revision } + error helpers
repository.ts   Row access (project/parent-scoped, revision increments)
service.ts      Invariants: project isolation, parent existence, append position
queries.ts      getStory/listStories/getScene/listScenes/getShot/listShots
commands.ts     Six handlers + payload schemas
```

Queries are project-scoped through the parent chain, so guessing an id can never
cross a project boundary.

## Transport extension

The transport (`src/core/commands/schema.ts`) was opened while keeping the
closed `BeatDesignCommand` union / `beatDesignCommandSchema` as the legacy
surface. A thin `openCommandEnvelopeSchema` recognises any non-empty `type` and
passes the payload through; the registered handler schema is the authority for
domain payload validation. Legacy type names are refused by the open envelope,
so a malformed built-in command can never fall through to the open path.

```text
transport → type string → payload unknown
  → registry.resolve(type) → handler.schema.parse(payload) → handler.execute
```

Unknown commands fail deterministically at the registry (`COMMAND_FAILED`);
invalid domain payloads fail as `INVALID_COMMAND` before the handler runs.

## Migration

Additive migration `0005_acoustic_abomination` creates `stories`, `scenes`,
`shots` + their indexes. No existing table or column was modified.

## Deferred capabilities

Explicitly deferred (Phase 3+):
Character / Character Bible / World Bible, Episode, Dialogue system, Script
parser, Screenplay format, Storyboard, Shot Asset linking, Generation
(`shot.generate`), Canvas Projection, Timeline Assembly, Agent tools, Continuity,
Bulk reorder / drag reorder normalization, Delete semantics, MCP auto-generation,
Event sourcing / undo op-log, workflow engine.
# Phase 2B — Story Workspace & Shot Canvas Projection (Design)

> Status: Active implementation design. This is the internal design (Step 4 of the
> Phase 2B spec), not yet the completion report. It records the read boundary,
> workspace state, projection representation, reconciliation algorithm, and write
> path before code lands, per the Phase 2B implementation order.

## 1. Objective

Give a user the ability to, for the first time in Slate:

```text
enter a Story
 → choose a Scene
 → see and arrange that Scene's Shots on a Canvas
 → edit a Shot through an Inspector
 → Shot Domain changes, Canvas rerenders (Canvas is only a projection)
```

Hard boundaries that Phase 2B must not cross:

```text
Domain = source of truth      (story/scene/shot relational rows)
Story Canvas = projection     (shot cards in the shared project snapshot)
Media Canvas = preserve-only  (opaque shot cards survive snapshot round-trips)
Timeline = assembly           (untouched this phase)
Provider = execution detail   (untouched this phase)
Asset = immutable media       (untouched this phase)
```

No Generation, Asset linkage, Timeline integration, Agent, Character, Episode,
Dialogue, or Continuity is implemented this phase.

## 2. Domain is authoritative; Canvas is a projection

A Shot is a Domain row (Phase 2A, `shots` table). A Shot **card** on the Canvas
is a thin projection. The card carries only enough to *identify* the projection
and *place* it on the canvas. All authoritative Shot data (description, duration,
narrative position, revision) is read from the Domain read model, never from the
card.

Projection card persisted fields (the ONLY authoritative-on-canvas fields):

```text
[card].id        → deterministic projection id `shot:<shotId>`
[card].kind      → 'shot'  (the single new projection kind)
[card].type      → a fixed media placeholder, e.g. 'image' (so it flows through
                   the existing snapshot/canvas validation)
[card].shotId    → the owning Domain shot id  (the projection's link)
[card].name      → display label (snapshot may carry one; rendered content is
                   always derived from Domain)
[card].url       → null
+ x/y/w/h in the snapshot `frames` record (React Flow layout, not Domain)
```

Not stored on the card (must come from the Domain read model): description,
durationMs, narrative `position`, `revision`, scene title, provider, prompt,
asset, generation.

## 3. Read boundary

The UI never imports the DB or the Story repository. Reads go through a
project-scoped `GET /api/app/projects/:projectId/story-workspace` route that
returns a `StoryWorkspaceReadModel`:

```text
StoryWorkspaceReadModel {
  projectId
  stories: Story[]                    // ordered
  story: Story | null                 // the requested/selected story (subset of stories)
  scenes: Scene[]                     // ordered by position (subset, for the loaded story)
  allShots: Shot[]                    // project-wide ids for safe orphan cleanup
  currentScene: {
    scene: Scene | null
    shots: Shot[]                     // ordered by position, project-scoped
  }
}
```

All story/scene/shot read queries already enforce project ownership through the
parent chain, so a guessed id can never cross a project boundary (Phase 2A).

The UI reads the workspace through a TanStack Query hook keyed by project +
story + scene. A command success invalidates this query so the read model is
re-fetched and Canvas projections are reconciled from fresh Domain data.

## 4. Workspace / navigation state (NOT Domain fields)

```text
currentStoryId   (workspace/navigation)
currentSceneId   (workspace/navigation)
selectedShotId   (workspace/navigation; inspection only)
```

These live in React/route query state. They are never written into the
`stories`/`scenes`/`shots` rows (no `current_scene_id`, no `selected` column).
Scene navigation is purely client-side.

Routing: a new `story` workspace mode at `/story/:projectId` (matching the
existing `/canvas` · `/studio` · `/editor` · `/assets` mode pattern), carrying
optional `?story=<storyId>&scene=<sceneId>` query params for deep-linking.

## 5. Shot Projection Reconciliation

Reconciliation decides which Canvas shot-projection cards exist for the current
scene's Domain Shots. It is deterministic and idempotent.

```text
currentScene.domainShots
        ↓
for each domain shot:
    existing projection card with card.shotId === shot.id ?
        yes → keep the same card.id and its existing frames (x/y preserved)
        no  → create a projection card at a default position
```

- Existence source of truth = Domain Shots. A projection with no matching Domain
  shot (orphan) is removed during reconciliation (never creates a Domain shot).
- One `shotId` → at most one primary projection card in the project snapshot.
- Default placement is deterministic: sequential horizontal row using the shot's
  Domain `position` (position + 1 is the `SHOT 01` label), no auto-layout engine.
- Reconciliation never writes domain data; it only upserts the thin card + frame.

Reconciliation is implemented as a pure function (`reconcileShotProjections`),
testable without a browser.

## 6. Canvas persistence: reuse the existing project snapshot

Shot projections are stored in the existing project snapshot document
(`cards` + `frames`), exactly like asset/generation/output cards. No new
projection/shot-layout table, no DB migration.

- Serialization: `buildProjectSnapshotDocument` passes ordinary Media Canvas
  cards through as before. The Media Canvas adapter separately carries the
  `shot` partition as opaque preserved state when it captures a snapshot.
- Deserialization: `createProjectSnapshotRestorePlan` exposes a `shot` partition
  so the Media Canvas can retain those cards and frames without materializing
  them as Media Canvas nodes. Only the Story Workspace renders Shot cards; the
  Media Canvas never displays, selects, drags, deletes, copies, or connects them.
- Layout persistence for a dragged card uses `canvas.apply { move_card }` through
  `persistBeatDesignCommand`, the same command path the existing media canvas
  uses. This reuses the existing CAS / conflict-retry / receipt machinery.
- Scene switching keeps every scene's layout: each shot projection card owns its
  own id + frame in the snapshot; switching scene only changes which cards are
  displayed, never deletes the others.

### 6.1 Snapshot schema compatibility (no breaking version)

`CanvasCardKind` widens from the closed 3-kind union to include `'shot'`; the
snapshot document version stays `3`. All existing asset/generation/output cards
and old snapshots continue to load unchanged. A project with no Story domain and
existing Canvas cards still opens and shows the Story Workspace empty state
without breaking the old cards.

## 7. Write path

All mutation flows through the existing command transport — never a new
`/api/story/update` repository bypass:

```text
Domain writes:
UI → POST /api/app/projects/:projectId/commands
   → uiCommandRequestSchema (open envelope)
   → persistBeatDesignCommand
   → command registry (story.* / scene.* / shot.*)
   → Story/Scene/Shot domain service → relational DB
   → receipt
   → UI invalidates the story-workspace query
   → workspace refresh
   → reconcile
   → Canvas rerender

Projection layout writes:
UI → POST /api/app/projects/:projectId/commands
   → persistBeatDesignCommand (canvas.apply { move_card / upsert_card })
  → canvas handler → snapshot CAS save
  → Story Canvas rerender (x/y only; Domain untouched)
```

Invariants preserved:
- Editing a Shot always mutates Domain via `shot.update` with `expectedRevision`
  (stale writes → `REVISION_CONFLICT`, surfaced, never silent).
- Deleting a Shot uses `shot.delete` with `expectedRevision`; successful Domain
  deletion removes its stale projection during the next project-wide reconcile.
- Dragging a Shot card changes card frame (x/y) only — never `shot.position` or
  `shot.revision`.
- No optimistic mutation in this phase (no three-way merge UI needed beyond what
  the existing snapshot lifecycle already provides for canvas saves).

## 8. Workspace UX

Three-pane, inside the existing `ProductPageShell` (no parallel app):

```text
┌──────────────────────────────────────────────────────┐
│ Story Workspace  [story selector] [scene breadcrumb] │
├───────────────┬───────────────────────┬──────────────┤
│ Scene         │  Shot Canvas          │ Shot         │
│ Navigator     │  (React Flow)         │ Inspector    │
│  ▸ Scene 01   │  [SHOT 01] [SHOT 02]  │  description │
│  ▸ Scene 02   │  [SHOT 03]            │  duration    │
│  + Scene      │  + Shot               │  position    │
└───────────────┴───────────────────────┴──────────────┘
```

- **Story/Scene Navigator (left, narrow):** story selector (when project has
  multiple stories), `+ Story` (empty state), scene list by position+title,
  `+ Scene`.
- **Shot Canvas (center):** current scene's shot projection cards on a
  React Flow canvas. Cards show `SHOT NN`, description, duration, all derived
  from the Domain read model. `+ Shot`.
- **Shot Inspector (right):** when a Shot is selected, edit description /
  durationMs / position through `shot.update` with `expectedRevision`, or delete
  it through `shot.delete` with the same CAS protection.
- **Story header:** optional title/premise view (read; edit via `story.update`).

Empty / error states: "Create your first story" · "Create first scene" ·
"Add first shot" · NOT_FOUND / REVISION_CONFLICT / INVALID_COMMAND /
COMMAND_FAILED surfaced through existing toast/alert UI.

## 9. Scope guard

This design adds exactly ONE Canvas card kind (`shot`) and ONE new workspace
surface (Story Workspace). The media canvas's asset/generation/output behavior is
unchanged; it only gains the ability to preserve shot cards opaquely. No
Foundation rewrite, no Command Registry V2, no new DB tables, no schema version
bump.

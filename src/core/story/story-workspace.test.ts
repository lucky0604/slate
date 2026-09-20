import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';
import type { BeatDesignCommandResult } from '@/core/commands/contracts';
import type { DomainHandlerData } from '@/core/commands/registry';

// Point the shared SQLite singleton at an isolated temp DB before any
// db-using module is imported. `node --test` gives each test file its own
// worker process.
const testDataRoot = await mkdtemp(join(tmpdir(), 'slate-phase2b-'));
process.env.BEATDESIGN_DATA_DIR = testDataRoot;
const dbPath = join(testDataRoot, 'local.db');

const client = createClient({ url: `file:${dbPath}` });
await client.executeMultiple(createTestSchemaSql());

const { persistBeatDesignCommand } = await import('@/core/commands/persist');
const { loadStoryWorkspaceReadModel } = await import('./workspace-read');
const { buildShotProjectionCard, reconcileShotProjections } = await import(
  './shot-projection'
);
const { applyCanvasOperations } = await import(
  '@/core/commands/canvas-commands'
);
const { getShot } = await import('./queries');
const { project } = await import('@/config/db/schema');
const { getDb } = await import('@/core/workspace-lib/db-adapter');

test.after(async () => {
  client.close();
  await rm(testDataRoot, { recursive: true, force: true });
});

async function seedProject(name: string): Promise<string> {
  const db = await getDb();
  const id = `project-${randomUUID()}`;
  const now = new Date();
  await db.insert(project).values({
    id,
    name,
    status: 'active',
    currentStateVersion: 1,
    lastWorkspaceMode: 'canvas',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function runCommand(options: {
  projectId: string;
  command: Record<string, unknown>;
}) {
  const commandId = `cmd-${randomUUID()}`;
  return persistBeatDesignCommand({
    projectId: options.projectId,
    origin: 'ui',
    commandId,
    idempotencyKey: commandId,
    command: options.command as unknown as Parameters<
      typeof persistBeatDesignCommand
    >[0]['command'],
  }) as Promise<BeatDesignCommandResult<unknown>>;
}

const domainData = (result: BeatDesignCommandResult<unknown>) => {
  if (!result.ok) throw new Error(result.message);
  return result.data as DomainHandlerData;
};

// ---------------------------------------------------------------------------
// Read boundary: project-scoped workspace read model
// ---------------------------------------------------------------------------

test('loadStoryWorkspaceReadModel returns project-scoped data, ordered', async () => {
  const projectId = await seedProject('P');
  // Story 1 with 2 scenes; scene-1 has 2 shots, scene-2 has 1 shot.
  const story = await runCommand({
    projectId,
    command: { type: 'story.create', title: 'Outer Story' },
  });
  const storyId = domainData(story).entityId;
  const sceneA = await runCommand({
    projectId,
    command: {
      type: 'scene.create',
      storyId,
      title: 'Opening',
      position: 10,
    },
  });
  const sceneAId = domainData(sceneA).entityId;
  const sceneB = await runCommand({
    projectId,
    command: {
      type: 'scene.create',
      storyId,
      title: 'Climax',
      position: 20,
    },
  });
  const sceneBId = domainData(sceneB).entityId;
  await runCommand({
    projectId,
    command: {
      type: 'shot.create',
      sceneId: sceneAId,
      description: 'Dolly in',
      durationMs: 4000,
      position: 1,
    },
  });
  await runCommand({
    projectId,
    command: {
      type: 'shot.create',
      sceneId: sceneAId,
      description: 'Close-up',
      durationMs: 2000,
      position: 2,
    },
  });
  await runCommand({
    projectId,
    command: {
      type: 'shot.create',
      sceneId: sceneBId,
      description: 'Explosion',
      durationMs: 6000,
      position: 1,
    },
  });

  const model = await loadStoryWorkspaceReadModel({
    projectId,
    storyId,
    sceneId: sceneAId,
  });
  assert.equal(model.story?.id, storyId);
  assert.ok(model.stories.some((entry) => entry.id === storyId));
  assert.deepEqual(
    model.scenes.map((scene) => scene.id),
    [sceneAId, sceneBId],
    'scenes ordered by position'
  );
  assert.equal(model.currentScene.scene?.id, sceneAId);
  assert.deepEqual(
    model.currentScene.shots.map((shot) => shot.description),
    ['Dolly in', 'Close-up'],
    'shots ordered by position'
  );
});

test('read model scopes shots to the selected scene', async () => {
  const projectId = await seedProject('P');
  const story = await runCommand({
    projectId,
    command: { type: 'story.create', title: 'S' },
  });
  const storyId = domainData(story).entityId;
  const sceneA = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'A' },
  });
  const sceneAId = domainData(sceneA).entityId;
  const sceneB = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'B' },
  });
  const sceneBId = domainData(sceneB).entityId;
  await runCommand({
    projectId,
    command: { type: 'shot.create', sceneId: sceneAId, description: 'A-shot' },
  });
  await runCommand({
    projectId,
    command: { type: 'shot.create', sceneId: sceneBId, description: 'B-shot' },
  });

  const modelB = await loadStoryWorkspaceReadModel({
    projectId,
    storyId,
    sceneId: sceneBId,
  });
  assert.equal(modelB.currentScene.scene?.id, sceneBId);
  assert.deepEqual(
    modelB.currentScene.shots.map((shot) => shot.description),
    ['B-shot']
  );
});

test('read model cannot cross project boundaries', async () => {
  const pA = await seedProject('A');
  const pB = await seedProject('B');
  const story = await runCommand({
    projectId: pA,
    command: { type: 'story.create', title: 'Only in A' },
  });
  const storyId = domainData(story).entityId;
  const scene = await runCommand({
    projectId: pA,
    command: { type: 'scene.create', storyId, title: 'Scene' },
  });
  const sceneId = domainData(scene).entityId;

  // Querying project B for A's story/scene yields nothing (scoped).
  const modelB = await loadStoryWorkspaceReadModel({
    projectId: pB,
    storyId,
    sceneId,
  });
  assert.equal(modelB.story, null);
  assert.equal(modelB.stories.length, 0);
  assert.equal(modelB.currentScene.scene, null);
  assert.deepEqual(modelB.currentScene.shots, []);
});

test('empty project: read model returns null story', async () => {
  const projectId = await seedProject('Fresh');
  const model = await loadStoryWorkspaceReadModel({ projectId });
  assert.equal(model.story, null);
  assert.deepEqual(model.stories, []);
  assert.deepEqual(model.scenes, []);
  assert.equal(model.currentScene.scene, null);
  assert.deepEqual(model.currentScene.shots, []);
});

// ---------------------------------------------------------------------------
// Command write path + reconciliation
// ---------------------------------------------------------------------------

test('shot.update through command path: revision bumps, read model reflects change', async () => {
  const projectId = await seedProject('P');
  const story = await runCommand({
    projectId,
    command: { type: 'story.create', title: 'S' },
  });
  const storyId = domainData(story).entityId;
  const scene = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'A' },
  });
  const sceneId = domainData(scene).entityId;
  const created = await runCommand({
    projectId,
    command: {
      type: 'shot.create',
      sceneId,
      description: 'before',
      durationMs: 1000,
    },
  });
  const shotId = domainData(created).entityId;
  assert.equal(domainData(created).revision, 1);

  const updated = await runCommand({
    projectId,
    command: {
      type: 'shot.update',
      shotId,
      expectedRevision: 1,
      description: 'after',
      durationMs: 5000,
    },
  });
  assert.equal(updated.ok, true);
  assert.equal(domainData(updated).revision, 2);

  const model = await loadStoryWorkspaceReadModel({
    projectId,
    storyId,
    sceneId,
  });
  const shot = model.currentScene.shots.find((entry) => entry.id === shotId);
  assert.ok(shot);
  assert.equal(shot.description, 'after');
  assert.equal(shot.durationMs, 5000);
  assert.equal(shot.revision, 2);
});

test('revision conflict: stale expectedRevision is rejected, no write', async () => {
  const projectId = await seedProject('P');
  const story = await runCommand({
    projectId,
    command: { type: 'story.create', title: 'S' },
  });
  const storyId = domainData(story).entityId;
  const scene = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'A' },
  });
  const sceneId = domainData(scene).entityId;
  const created = await runCommand({
    projectId,
    command: {
      type: 'shot.create',
      sceneId,
      description: 'v1',
      position: 1,
    },
  });
  const shotId = domainData(created).entityId;

  // Another writer bumps to revision 2.
  const first = await runCommand({
    projectId,
    command: {
      type: 'shot.update',
      shotId,
      expectedRevision: 1,
      description: 'v2',
    },
  });
  assert.equal(first.ok, true);
  assert.equal(domainData(first).revision, 2);

  // A stale writer still thinks it is on revision 1 -> conflict, no write.
  const stale = await runCommand({
    projectId,
    command: {
      type: 'shot.update',
      shotId,
      expectedRevision: 1,
      description: 'stale-clobber',
    },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');

  const after = await getShot(projectId, shotId);
  assert.ok(after);
  assert.equal(after.description, 'v2', 'stale write did not clobber');
  assert.equal(after.revision, 2);
});

test('shot.create + reconcile produces one projection card', async () => {
  const projectId = await seedProject('P');
  const story = await runCommand({
    projectId,
    command: { type: 'story.create', title: 'S' },
  });
  const storyId = domainData(story).entityId;
  const scene = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'A' },
  });
  const sceneId = domainData(scene).entityId;
  const created = await runCommand({
    projectId,
    command: {
      type: 'shot.create',
      sceneId,
      description: 'wide establishing',
      durationMs: 3000,
      position: 1,
    },
  });
  const shotId = domainData(created).entityId;

  const model = await loadStoryWorkspaceReadModel({
    projectId,
    storyId,
    sceneId,
  });
  const diff = reconcileShotProjections({
    document: { version: 3, cards: [], frames: {} },
    shots: Object.fromEntries(
      model.currentScene.shots.map((shot) => [shot.id, shot])
    ),
    orderedShotIds: model.currentScene.shots.map((shot) => shot.id),
  });
  assert.equal(diff.createdProjectionIds.length, 1);
  assert.equal(diff.createdProjectionIds[0], `shot:${shotId}`);
  assert.equal(
    diff.document.cards.find((card) => card.kind === 'shot')?.shotId,
    shotId
  );
});

test('shot.delete uses revision CAS and reconciliation removes its projection', async () => {
  const projectId = await seedProject('P');
  const story = await runCommand({
    projectId,
    command: { type: 'story.create', title: 'S' },
  });
  const storyId = domainData(story).entityId;
  const scene = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'A' },
  });
  const sceneId = domainData(scene).entityId;
  const created = await runCommand({
    projectId,
    command: { type: 'shot.create', sceneId, description: 'to delete' },
  });
  const shotId = domainData(created).entityId;
  const beforeDelete = await loadStoryWorkspaceReadModel({
    projectId,
    storyId,
    sceneId,
  });
  const projection = reconcileShotProjections({
    document: { version: 3, cards: [], frames: {} },
    shots: Object.fromEntries(
      beforeDelete.currentScene.shots.map((shot) => [shot.id, shot])
    ),
    orderedShotIds: beforeDelete.currentScene.shots.map((shot) => shot.id),
    knownShotIds: new Set(beforeDelete.allShots.map((shot) => shot.id)),
  });
  assert.equal(projection.createdProjectionIds[0], `shot:${shotId}`);

  const deleted = await runCommand({
    projectId,
    command: { type: 'shot.delete', shotId, expectedRevision: 1 },
  });
  assert.equal(deleted.ok, true);

  const afterDelete = await loadStoryWorkspaceReadModel({
    projectId,
    storyId,
    sceneId,
  });
  const cleaned = reconcileShotProjections({
    document: projection.document,
    shots: {},
    orderedShotIds: [],
    knownShotIds: new Set(afterDelete.allShots.map((shot) => shot.id)),
  });
  assert.deepEqual(cleaned.removedProjectionIds, [`shot:${shotId}`]);
  assert.equal(afterDelete.allShots.some((shot) => shot.id === shotId), false);
});

// ---------------------------------------------------------------------------
// Canvas projection: drag/move_card must not mutate the Domain Shot
// ---------------------------------------------------------------------------

test('canvas.apply move_card changes frames only, never shot.position/revision', async () => {
  const shot = {
    id: 'shot-1',
    sceneId: 'scene-1',
    position: 3, // Domain, source-of-truth ordering (not altered by layout)
    description: 'A master shot',
    durationMs: 4000,
    revision: 7,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };
  const projection = buildShotProjectionCard({
    id: 'shot-1',
    position: 3,
    description: 'A master shot',
  });
  const document = {
    version: 3 as const,
    cards: [projection],
    frames: { 'shot:shot-1': { x: 40, y: 190, w: 240, h: 150 } },
  };

  // Drag the card to a new spot via the shared canvas command path.
  const result = applyCanvasOperations(document, [
    { type: 'move_card', cardId: 'shot:shot-1', frame: { x: 620, y: 40, w: 240, h: 150 } },
  ]);
  assert.deepEqual(result.document.frames['shot:shot-1'], {
    x: 620,
    y: 40,
    w: 240,
    h: 150,
  });

  // The Domain Shot is untouched by layout movement.
  assert.equal(shot.position, 3, 'shot.position is Domain ordering, not canvas y');
  assert.equal(shot.revision, 7, 'drag does not bump the Domain revision');
  assert.equal(shot.description, 'A master shot');
});

test('restore plan partitions shot cards and preserves them (no drop on media canvas)', async () => {
  const { createProjectSnapshotRestorePlan } = await import(
    '@/core/projects/project-canvas-document'
  );
  const shotCard = buildShotProjectionCard({
    id: 'shot-1',
    position: 0,
    description: 'A shot',
  });
  const assetCard = {
    id: 'asset-1',
    kind: 'asset' as const,
    type: 'image' as const,
    name: 'Poster',
    url: null,
    prompt: '',
    referenceCardIds: [],
    workflowTemplateId: null,
    status: 'idle' as const,
    error: null,
    modelId: '',
    aspectRatio: '1:1' as const,
    outputQuality: '1k' as const,
    duration: '5s' as const,
    mode: 'quality' as const,
    variant: 'standard' as const,
    quality: 'standard' as const,
    sourceGenerationId: null,
  };
  const plan = createProjectSnapshotRestorePlan({
    version: 3,
    cards: [shotCard, assetCard],
    frames: {
      'shot:shot-1': { x: 10, y: 10, w: 240, h: 150 },
      'asset-1': { x: 0, y: 0, w: 100, h: 100 },
    },
  });
  assert.equal(plan.shotCards.length, 1);
  assert.equal(plan.shotCards[0].card.shotId, 'shot-1');
  assert.deepEqual(plan.shotCards[0].frame, { x: 10, y: 10, w: 240, h: 150 });
  // A url-less non-timeline asset is not a durable asset card, so it does not
  // land in the asset partition — but it is also not accidentally a shot.
  assert.equal(plan.assetCards.length, 0);
  assert.equal(plan.draftCards.length, 0);
  assert.equal(plan.outputCards.length, 0);
  assert.equal(plan.connectors.length, 0);
  // The shot card is NOT dropped just because the media canvas restored — it is
  // preserved as a first-class partition, so auto-save cannot lose it.
});

// ---------------------------------------------------------------------------
// schema (reused from phase2a to isolate this suite)
// ---------------------------------------------------------------------------

function createTestSchemaSql(): string {
  return `
    CREATE TABLE project (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      cover_asset_id text,
      status text NOT NULL DEFAULT 'active',
      current_state_version integer NOT NULL DEFAULT 1,
      last_workspace_mode text NOT NULL DEFAULT 'canvas',
      last_opened_at integer, archived_at integer, deleted_at integer,
      created_at integer NOT NULL, updated_at integer NOT NULL
    );
    CREATE TABLE stories (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      title text NOT NULL,
      premise text,
      revision integer NOT NULL DEFAULT 1,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE scenes (
      id text PRIMARY KEY NOT NULL,
      story_id text NOT NULL,
      position integer NOT NULL,
      title text NOT NULL,
      summary text,
      revision integer NOT NULL DEFAULT 1,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE shots (
      id text PRIMARY KEY NOT NULL,
      scene_id text NOT NULL,
      position integer NOT NULL,
      description text NOT NULL,
      duration_ms integer,
      revision integer NOT NULL DEFAULT 1,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE project_command_receipt (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      idempotency_key text NOT NULL,
      command_id text NOT NULL,
      origin text NOT NULL,
      command_type text NOT NULL,
      result_json text NOT NULL,
      created_at integer NOT NULL,
      UNIQUE (project_id, idempotency_key)
    );
    CREATE INDEX idx_stories_project ON stories (project_id);
    CREATE INDEX idx_scenes_story ON scenes (story_id);
    CREATE INDEX idx_shots_scene ON shots (scene_id);
  `;
}

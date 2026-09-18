import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';
import type { BeatDesignCommandResult } from '@/core/commands/contracts';
import type { DomainHandlerData } from '@/core/commands/registry';

const domainData = (result: { data: unknown }) => result.data as DomainHandlerData;

// Point the shared SQLite singleton at an isolated temp DB before any
// db-using module is imported. `node --test` gives each test file its own
// worker process, so this does not affect other test files.
const testDataRoot = await mkdtemp(join(tmpdir(), 'slate-phase2a-'));
process.env.BEATDESIGN_DATA_DIR = testDataRoot;
const dbPath = join(testDataRoot, 'local.db');

const client = createClient({ url: `file:${dbPath}` });
await client.executeMultiple(createTestSchemaSql());

const { persistBeatDesignCommand } = await import('@/core/commands/persist');
const { commandRegistry } = await import('@/core/commands/executor');
const {
  createStory: createStoryService,
  createScene: createSceneService,
  createShot: createShotService,
} = await import('@/core/story/service');
const {
  getStory,
  listStories,
  getScene,
  listScenes,
  getShot,
  listShots,
} = await import('@/core/story/queries');
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

/** Run a full command through the production persist path (receipt + registry). */
async function runCommand(options: {
  projectId: string;
  command: Record<string, unknown>;
  commandId?: string;
  idempotencyKey?: string;
}) {
  const commandId = options.commandId ?? `cmd-${randomUUID()}`;
  return persistBeatDesignCommand({
    projectId: options.projectId,
    origin: 'ui',
    commandId,
    idempotencyKey: options.idempotencyKey ?? commandId,
    command: options.command as unknown as Parameters<
      typeof persistBeatDesignCommand
    >[0]['command'],
  }) as Promise<BeatDesignCommandResult<unknown>>;
}

async function countRows(table: 'stories' | 'scenes' | 'shots'): Promise<number> {
  const result = await client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  const row = result.rows[0] as unknown as { c: number };
  return Number(row.c);
}

// ---------------------------------------------------------------------------
// createStory / updateStory
// ---------------------------------------------------------------------------

test('story.create + story.update through the production registry', async () => {
  const projectId = await seedProject('P');
  const created = await runCommand({
    projectId,
    command: { type: 'story.create', title: '  The Great Heist  ' },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(domainData(created).entityType, 'story');
  assert.equal(domainData(created).revision, 1);
  const storyId = domainData(created).entityId;

  const story = await getStory(projectId, storyId);
  assert.ok(story);
  assert.equal(story.title, 'The Great Heist'); // trimmed
  assert.equal(story.premise, null);
  assert.equal(story.revision, 1);

  const updated = await runCommand({
    projectId,
    command: {
      type: 'story.update',
      storyId,
      expectedRevision: 1,
      premise: 'A crew plans an impossible job.',
    },
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(domainData(updated).revision, 2);

  const after = await getStory(projectId, storyId);
  assert.equal(after?.revision, 2);
  assert.equal(after?.premise, 'A crew plans an impossible job.');
});

// ---------------------------------------------------------------------------
// scene.create / scene.update with append position
// ---------------------------------------------------------------------------

test('scene.create appends position 0,1,2 and scene.update reorders', async () => {
  const projectId = await seedProject('P');
  const storyId = (await createStoryService(projectId, { title: 'Act I' })).entityId;

  const s0 = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'Opening' },
  });
  const s1 = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'Middle' },
  });
  const s2 = await runCommand({
    projectId,
    command: { type: 'scene.create', storyId, title: 'Climax' },
  });
  assert.ok(s0.ok && s1.ok && s2.ok);

  const scenes = await listScenes(projectId, storyId);
  assert.deepEqual(scenes.map((s) => s.position), [0, 1, 2]);
  assert.deepEqual(scenes.map((s) => s.title), ['Opening', 'Middle', 'Climax']);

  // scene.update(position) is supported as a minimal ordering capability.
  const mid = s1.ok ? domainData(s1).entityId : '';
  const updated = await runCommand({
    projectId,
    command: { type: 'scene.update', sceneId: mid, expectedRevision: 1, position: 2 },
  });
  assert.equal(updated.ok, true);
});

// ---------------------------------------------------------------------------
// shot.create / shot.update
// ---------------------------------------------------------------------------

test('shot.create + shot.update with durationMs', async () => {
  const projectId = await seedProject('P');
  const storyId = (await createStoryService(projectId, { title: 'Story' })).entityId;
  const sceneId = (await createSceneService(projectId, { storyId, title: 'Scene' })).entityId;

  const created = await runCommand({
    projectId,
    command: { type: 'shot.create', sceneId, description: 'Wide shot.', durationMs: 5000 },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const shotId = domainData(created).entityId;

  const shot = await getShot(projectId, shotId);
  assert.equal(shot?.durationMs, 5000);
  assert.equal(shot?.revision, 1);

  const updated = await runCommand({
    projectId,
    command: { type: 'shot.update', shotId, expectedRevision: 1, durationMs: 8000 },
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(domainData(updated).revision, 2);
  assert.equal((await getShot(projectId, shotId))?.durationMs, 8000);
});

// ---------------------------------------------------------------------------
// relationship chain + queries
// ---------------------------------------------------------------------------

test('full Project -> Story -> Scene -> Shot chain resolves via queries', async () => {
  const projectId = await seedProject('P');
  const storyId = (await createStoryService(projectId, { title: 'Chain' })).entityId;
  const sceneId = (await createSceneService(projectId, { storyId, title: 'Scene A' })).entityId;
  await createShotService(projectId, { sceneId, description: 'Shot 1' });
  await createShotService(projectId, { sceneId, description: 'Shot 2' });

  assert.equal((await listStories(projectId)).length, 1);
  assert.equal((await getScene(projectId, sceneId))?.storyId, storyId);
  const shots = await listShots(projectId, sceneId);
  assert.deepEqual(shots.map((s) => s.position), [0, 1]);
  assert.equal((await getShot(projectId, shots[0].id))?.sceneId, sceneId);
});

// ---------------------------------------------------------------------------
// revision conflict
// ---------------------------------------------------------------------------

test('optimistic concurrency: stale expectedRevision yields REVISION_CONFLICT', async () => {
  const projectId = await seedProject('P');
  const storyId = (await createStoryService(projectId, { title: 'Concurrent' })).entityId;

  const first = await runCommand({
    projectId,
    command: { type: 'story.update', storyId, expectedRevision: 1, title: 'V1' },
  });
  assert.equal(first.ok, true);

  const stale = await runCommand({
    projectId,
    command: { type: 'story.update', storyId, expectedRevision: 1, title: 'V2 stale' },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, 'REVISION_CONFLICT');
  }

  const fresh = await runCommand({
    projectId,
    command: { type: 'story.update', storyId, expectedRevision: 2, title: 'V2' },
  });
  assert.equal(fresh.ok, true);
});

test('scene update stale revision is also a REVISION_CONFLICT', async () => {
  const projectId = await seedProject('P');
  const sceneId = (
    await createSceneService(
      projectId,
      { storyId: (await createStoryService(projectId, { title: 'S' })).entityId, title: 'Sc' }
    )
  ).entityId;
  const first = await runCommand({
    projectId,
    command: { type: 'scene.update', sceneId, expectedRevision: 1, title: 'New' },
  });
  assert.equal(first.ok, true);
  const stale = await runCommand({
    projectId,
    command: { type: 'scene.update', sceneId, expectedRevision: 1, summary: 'x' },
  });
  assert.ok(!stale.ok);
  if (!stale.ok) assert.equal(stale.code, 'REVISION_CONFLICT');
});

// ---------------------------------------------------------------------------
// cross-project isolation
// ---------------------------------------------------------------------------

test('Project A rows cannot be read or written from Project B', async () => {
  const projectA = await seedProject('A');
  const projectB = await seedProject('B');
  const storyA = (await createStoryService(projectA, { title: 'A story' })).entityId;

  // Read isolation: Project B cannot see Project A's story.
  assert.equal(await getStory(projectB, storyA), null);
  assert.deepEqual(await listStories(projectB), []);

  // Write isolation: Project B cannot update Project A's story.
  const updateB = await runCommand({
    projectId: projectB,
    command: { type: 'story.update', storyId: storyA, expectedRevision: 1, title: 'hacked' },
  });
  assert.equal(updateB.ok, false);
  if (!updateB.ok) assert.equal(updateB.code, 'NOT_FOUND');
  assert.notEqual((await getStory(projectA, storyA))?.title, 'hacked');
});

// ---------------------------------------------------------------------------
// parent validation / cross-project parent
// ---------------------------------------------------------------------------

test('scene.create rejects a Story owned by another project', async () => {
  const projectA = await seedProject('A');
  const projectB = await seedProject('B');
  const storyA = (await createStoryService(projectA, { title: 'A story' })).entityId;
  const before = await countRows('scenes');

  const cross = await runCommand({
    projectId: projectB,
    command: { type: 'scene.create', storyId: storyA, title: 'Scene' },
  });
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.code, 'NOT_FOUND');

  // No scene row was inserted by the cross-project create.
  assert.equal(await countRows('scenes'), before);
});

test('shot.create rejects a Scene owned by another project', async () => {
  const projectA = await seedProject('A');
  const projectB = await seedProject('B');
  const storyA = (await createStoryService(projectA, { title: 'A story' })).entityId;
  const sceneA = (await createSceneService(projectA, { storyId: storyA, title: 'Sc' })).entityId;

  const cross = await runCommand({
    projectId: projectB,
    command: { type: 'shot.create', sceneId: sceneA, description: 'x' },
  });
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

test('repeating the same story.create command id creates exactly one row', async () => {
  const projectId = await seedProject('P');
  const commandId = `idem-${randomUUID()}`;
  const command = { type: 'story.create', title: 'Idempotent' };
  const before = await countRows('stories');

  const first = await runCommand({ projectId, command, commandId });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const storyId = domainData(first).entityId;

  // The second call reuses the same command id and is deduplicated by receipt.
  const second = await runCommand({ projectId, command, commandId });
  assert.equal(second.ok, true);
  assert.equal(domainData(second).entityId, storyId);

  const stories = await listStories(projectId);
  assert.equal(stories.length, 1);
  // Exactly one new story row across the two identical calls.
  assert.equal(await countRows('stories'), before + 1);
});

// ---------------------------------------------------------------------------
// invalid payload
// ---------------------------------------------------------------------------

test('invalid story.create payload (empty title) fails without writing', async () => {
  const projectId = await seedProject('P');
  const before = await countRows('stories');
  const result = await runCommand({
    projectId,
    command: { type: 'story.create', title: '' },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_COMMAND');
  }
  assert.equal(await countRows('stories'), before);
});

test('empty story.update (no mutable field) is a validation failure', async () => {
  const projectId = await seedProject('P');
  const storyId = (await createStoryService(projectId, { title: 'S' })).entityId;
  const result = await runCommand({
    projectId,
    command: { type: 'story.update', storyId, expectedRevision: 1 },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'INVALID_COMMAND');
});

// ---------------------------------------------------------------------------
// open transport: unknown command still fails; domain does not touch registry sync
// ---------------------------------------------------------------------------

test('unknown command type fails through the open transport', async () => {
  const projectId = await seedProject('P');
  const result = await runCommand({
    projectId,
    command: { type: 'story.delete', title: 'x' },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'COMMAND_FAILED');
});

test('domain commands are registered but not dispatchable through sync execute', async () => {
  assert.equal(commandRegistry.has('story.create'), true);
  assert.equal(commandRegistry.has('shot.update'), true);

  const sync = commandRegistry.execute(
    {
      commandId: 'c',
      projectId: 'p',
      origin: 'ui',
      command: { type: 'story.create', title: 'x' },
    },
    {}
  );
  assert.equal(sync.ok, false);
});

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
  `;
}
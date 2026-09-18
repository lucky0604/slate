import { randomUUID } from 'crypto';

import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '@/core/workspace-lib/db-adapter';
import {
  project,
  scene,
  shot,
  story,
  type NewScene,
  type NewShot,
  type NewStory,
  type Scene,
  type Shot,
  type Story,
} from '@/config/db/schema';

/**
 * A resolved database handle used by repository operations. Both the top-level
 * `getDb()` result and a nested Drizzle transaction can be passed, so appended
 * inserts and revision updates can run atomically. The handle only has to offer
 * the query-builder surface the repository uses.
 */
export type DbHandle = Awaited<ReturnType<typeof getDb>>;

async function resolve(db: DbHandle | undefined) {
  return db ?? getDb();
}

/**
 * Story / Scene / Shot persistence repository (Phase 2A).
 *
 * This is the only place that touches the relational domain tables. Services
 * put invariants (project isolation, parent existence, row revision) on top of
 * these low-level row operations. Methods that read-then-write (append
 * position) accept an optional `db` handle so a caller can wrap them in a
 * single Drizzle transaction.
 */
export const storyRepository = {
  /** Whether a project row exists (for a clean NOT_FOUND on parent checks). */
  async projectExists(projectId: string): Promise<boolean> {
    const handle = await getDb();
    const rows = await handle
      .select({ id: project.id })
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1);
    return rows.length > 0;
  },

  /* ----------------------------------- story --------------------------------- */

  async insertStory(
    input: {
      projectId: string;
      title: string;
      premise: string | null;
    },
    db?: DbHandle
  ): Promise<Story> {
    const handle = await resolve(db);
    const now = new Date();
    const row: NewStory = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      premise: input.premise,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await handle.insert(story).values(row);
    return row as Story;
  },

  /**
   * Optimistic row update scoped by project ownership. Returns `true` only when
   * a row matching id + project + expectedRevision was updated; `false` when
   * the precondition failed (caller distinguishes NOT_FOUND from
   * REVISION_CONFLICT by re-reading ownership).
   */
  async updateStoryByIdAndRevision(input: {
    id: string;
    projectId: string;
    expectedRevision: number;
    title: string;
    premise: string | null;
  }, db?: DbHandle): Promise<boolean> {
    const handle = await resolve(db);
    const result = await handle
      .update(story)
      .set({
        title: input.title,
        premise: input.premise,
        revision: input.expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(story.id, input.id),
          eq(story.projectId, input.projectId),
          eq(story.revision, input.expectedRevision)
        )
      )
      .run();
    return affectedCount(result) === 1;
  },

  /** Resolve a story scoped to a project, or `null`. */
  async getStoryByIdForProject(
    projectId: string,
    storyId: string
  ): Promise<Story | null> {
    const handle = await getDb();
    const rows = await handle
      .select()
      .from(story)
      .where(and(eq(story.id, storyId), eq(story.projectId, projectId)))
      .limit(1);
    return rows[0] ?? null;
  },

  async listStoriesByProject(projectId: string): Promise<Story[]> {
    const handle = await getDb();
    return handle
      .select()
      .from(story)
      .where(eq(story.projectId, projectId))
      .orderBy(story.createdAt, story.id);
  },

  /* ----------------------------------- scene --------------------------------- */

  /** Resolve a scene's story id, but only when that story belongs to projectId. */
  async resolveSceneOwnership(
    projectId: string,
    sceneId: string
  ): Promise<{ storyId: string } | null> {
    const handle = await getDb();
    const rows = await handle
      .select({ storyId: scene.storyId })
      .from(scene)
      .innerJoin(story, eq(scene.storyId, story.id))
      .where(and(eq(scene.id, sceneId), eq(story.projectId, projectId)))
      .limit(1);
    return (rows[0] as { storyId: string } | undefined) ?? null;
  },

  async insertScene(input: {
    storyId: string;
    position: number;
    title: string;
    summary: string | null;
  }, db?: DbHandle): Promise<Scene> {
    const handle = await resolve(db);
    const now = new Date();
    const row: NewScene = {
      id: randomUUID(),
      storyId: input.storyId,
      position: input.position,
      title: input.title,
      summary: input.summary,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await handle.insert(scene).values(row);
    return row as Scene;
  },

  async updateSceneByIdAndRevision(input: {
    id: string;
    storyIdOfScene: string;
    expectedRevision: number;
    title: string;
    summary: string | null;
    position: number;
  }, db?: DbHandle): Promise<boolean> {
    const handle = await resolve(db);
    const result = await handle
      .update(scene)
      .set({
        title: input.title,
        summary: input.summary,
        position: input.position,
        revision: input.expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scene.id, input.id),
          eq(scene.revision, input.expectedRevision),
          eq(scene.storyId, input.storyIdOfScene)
        )
      )
      .run();
    return affectedCount(result) === 1;
  },

  async getSceneByIdForProject(
    projectId: string,
    sceneId: string
  ): Promise<Scene | null> {
    const handle = await getDb();
    const rows = await handle
      .select({ scene })
      .from(scene)
      .innerJoin(story, eq(scene.storyId, story.id))
      .where(and(eq(scene.id, sceneId), eq(story.projectId, projectId)))
      .limit(1);
    return rows[0]?.scene ?? null;
  },

  async listScenesByStory(
    projectId: string,
    storyId: string
  ): Promise<Scene[]> {
    const handle = await getDb();
    const rows = await handle
      .select({ scene })
      .from(scene)
      .innerJoin(story, eq(scene.storyId, story.id))
      .where(and(eq(scene.storyId, storyId), eq(story.projectId, projectId)))
      .orderBy(scene.position, scene.id);
    return rows.map((row: { scene: Scene }) => row.scene);
  },

  /** Append position for a new scene in a story: MAX(position)+1 (or 0). */
  async maxScenePosition(
    storyId: string,
    tx?: DbHandle
  ): Promise<number> {
    const handle = await resolve(tx);
    const rows = await handle
      .select({ position: scene.position })
      .from(scene)
      .where(eq(scene.storyId, storyId))
      .orderBy(desc(scene.position))
      .limit(1);
    return rows[0] ? rows[0].position + 1 : 0;
  },

  /* ----------------------------------- shot ---------------------------------- */

  /** Resolve a shot's scene id + story id, but only when scoped to projectId. */
  async resolveShotOwnership(
    projectId: string,
    shotId: string
  ): Promise<{ sceneId: string; storyId: string } | null> {
    const handle = await getDb();
    const rows = await handle
      .select({ sceneId: shot.sceneId, storyId: scene.storyId })
      .from(shot)
      .innerJoin(scene, eq(shot.sceneId, scene.id))
      .innerJoin(story, eq(scene.storyId, story.id))
      .where(and(eq(shot.id, shotId), eq(story.projectId, projectId)))
      .limit(1);
    return (rows[0] as { sceneId: string; storyId: string } | undefined) ?? null;
  },

  async insertShot(input: {
    sceneId: string;
    position: number;
    description: string;
    durationMs: number | null;
  }, db?: DbHandle): Promise<Shot> {
    const handle = await resolve(db);
    const now = new Date();
    const row: NewShot = {
      id: randomUUID(),
      sceneId: input.sceneId,
      position: input.position,
      description: input.description,
      durationMs: input.durationMs,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await handle.insert(shot).values(row);
    return row as Shot;
  },

  async updateShotByIdAndRevision(input: {
    id: string;
    sceneIdOfShot: string;
    expectedRevision: number;
    description: string;
    durationMs: number | null | undefined;
    position: number;
  }, db?: DbHandle): Promise<boolean> {
    const handle = await resolve(db);
    const set: Partial<NewShot> & { revision: number; updatedAt: Date } = {
      description: input.description,
      position: input.position,
      revision: input.expectedRevision + 1,
      updatedAt: new Date(),
    };
    if (input.durationMs !== undefined) {
      set.durationMs = input.durationMs;
    }
    const result = await handle
      .update(shot)
      .set(set)
      .where(
        and(
          eq(shot.id, input.id),
          eq(shot.revision, input.expectedRevision),
          eq(shot.sceneId, input.sceneIdOfShot)
        )
      )
      .run();
    return affectedCount(result) === 1;
  },

  async getShotByIdForProject(
    projectId: string,
    shotId: string
  ): Promise<Shot | null> {
    const handle = await getDb();
    const rows = await handle
      .select({ shot })
      .from(shot)
      .innerJoin(scene, eq(shot.sceneId, scene.id))
      .innerJoin(story, eq(scene.storyId, story.id))
      .where(and(eq(shot.id, shotId), eq(story.projectId, projectId)))
      .limit(1);
    return rows[0]?.shot ?? null;
  },

  async listShotsByScene(
    projectId: string,
    sceneId: string
  ): Promise<Shot[]> {
    const handle = await getDb();
    const rows = await handle
      .select({ shot })
      .from(shot)
      .innerJoin(scene, eq(shot.sceneId, scene.id))
      .innerJoin(story, eq(scene.storyId, story.id))
      .where(and(eq(shot.sceneId, sceneId), eq(story.projectId, projectId)))
      .orderBy(shot.position, shot.id);
    return rows.map((row: { shot: Shot }) => row.shot);
  },

  /** Append position for a new shot in a scene: MAX(position)+1 (or 0). */
  async maxShotPosition(
    sceneId: string,
    tx?: DbHandle
  ): Promise<number> {
    const handle = await resolve(tx);
    const rows = await handle
      .select({ position: shot.position })
      .from(shot)
      .where(eq(shot.sceneId, sceneId))
      .orderBy(desc(shot.position))
      .limit(1);
    return rows[0] ? rows[0].position + 1 : 0;
  },
} as const;

export type StoryRepository = typeof storyRepository;

function affectedCount(result: unknown): number {
  const value = result as { rowsAffected?: number };
  return typeof value.rowsAffected === 'number' ? value.rowsAffected : 0;
}
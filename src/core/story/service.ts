import { getDb } from '@/core/workspace-lib/db-adapter';

import type { DomainWriteResult } from './contracts';
import {
  domainConflictError,
  domainNotFoundError,
  domainValidationError,
} from './contracts';
import { storyRepository } from './repository';

/**
 * Story / Scene / Shot domain service (Phase 2A).
 *
 * The only authority for domain write invariants:
 * - project isolation (a command scoped to project A can never touch project B
 *   rows);
 * - parent existence (a scene needs a story in the same project, a shot needs a
 *   scene in the same project);
 * - row-level optimistic concurrency (updates use expectedRevision and detect
 *   stale writes);
 * - append order position when a create omits `position`.
 *
 * Handlers call these services; handlers never touch raw SQL or require the
 * command kernel to know the domain tables.
 */

const trim = (value: unknown): string | null =>
  typeof value === 'string' ? value.trim() : null;

const requireProject = async (projectId: string): Promise<void> => {
  if (!(await storyRepository.projectExists(projectId))) {
    throw domainNotFoundError('Project not found');
  }
};

/** Select-then-insert of an appended child must be atomic. */
type Db = Awaited<ReturnType<typeof getDb>>;
async function inDrizzleTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  const db = (await getDb()) as {
    transaction: <R>(fn: (tx: Db) => Promise<R>) => Promise<R>;
  };
  return db.transaction((tx) => work(tx));
}

/* ---------------------------------- story ---------------------------------- */

export async function createStory(
  projectId: string,
  input: { title: string; premise?: string | null }
): Promise<DomainWriteResult> {
  await requireProject(projectId);
  const title = trim(input.title);
  if (!title) {
    throw domainValidationError('Story title must be non-empty.');
  }
  const storyRow = await storyRepository.insertStory({
    projectId,
    title,
    premise: trim(input.premise),
  });
  return {
    entityType: 'story',
    entityId: storyRow.id,
    revision: storyRow.revision,
  };
}

export async function updateStory(
  projectId: string,
  input: {
    storyId: string;
    expectedRevision: number;
    title?: string | null;
    premise?: string | null;
  }
): Promise<DomainWriteResult> {
  const existing = await storyRepository.getStoryByIdForProject(
    projectId,
    input.storyId
  );
  if (!existing) {
    throw domainNotFoundError('Story not found');
  }
  const title = input.title === undefined ? existing.title : trim(input.title);
  if (!title) {
    throw domainValidationError('Story title must be non-empty.');
  }
  const premise =
    input.premise === undefined
      ? existing.premise
      : trim(input.premise) ?? null;

  const updated = await storyRepository.updateStoryByIdAndRevision({
    id: input.storyId,
    projectId,
    expectedRevision: input.expectedRevision,
    title,
    premise,
  });
  if (!updated) {
    // Precondition (id + project + revision) failed. The ownership read already
    // confirmed the row exists in this project, so the only remaining reason is
    // a stale revision.
    throw domainConflictError(
      `Story revision conflict: expected ${input.expectedRevision}.`
    );
  }
  return {
    entityType: 'story',
    entityId: input.storyId,
    revision: input.expectedRevision + 1,
  };
}

/* ---------------------------------- scene ---------------------------------- */

export async function createScene(
  projectId: string,
  input: {
    storyId: string;
    title: string;
    summary?: string | null;
    position?: number;
  }
): Promise<DomainWriteResult> {
  // Parent must exist AND belong to this project.
  const parent = await storyRepository.getStoryByIdForProject(
    projectId,
    input.storyId
  );
  if (!parent) {
    throw domainNotFoundError('Story not found in this project.');
  }
  const title = trim(input.title);
  if (!title) {
    throw domainValidationError('Scene title must be non-empty.');
  }

  const sceneRow = await inDrizzleTransaction(async (tx) => {
    const position =
      input.position === undefined
        ? await storyRepository.maxScenePosition(input.storyId, tx)
        : input.position;
    return storyRepository.insertScene(
      {
        storyId: input.storyId,
        position,
        title,
        summary: trim(input.summary),
      },
      tx
    );
  });
  return {
    entityType: 'scene',
    entityId: sceneRow.id,
    revision: sceneRow.revision,
  };
}

export async function updateScene(
  projectId: string,
  input: {
    sceneId: string;
    expectedRevision: number;
    title?: string | null;
    summary?: string | null;
    position?: number;
  }
): Promise<DomainWriteResult> {
  const ownership = await storyRepository.resolveSceneOwnership(
    projectId,
    input.sceneId
  );
  if (!ownership) {
    throw domainNotFoundError('Scene not found in this project.');
  }
  const existing = await storyRepository.getSceneByIdForProject(
    projectId,
    input.sceneId
  );
  if (!existing) {
    throw domainNotFoundError('Scene not found in this project.');
  }
  const title = input.title === undefined ? existing.title : trim(input.title);
  if (!title) {
    throw domainValidationError('Scene title must be non-empty.');
  }
  const summary =
    input.summary === undefined ? existing.summary : (trim(input.summary) ?? null);
  const position =
    input.position === undefined ? existing.position : input.position;

  const updated = await storyRepository.updateSceneByIdAndRevision({
    id: input.sceneId,
    storyIdOfScene: ownership.storyId,
    expectedRevision: input.expectedRevision,
    title,
    summary,
    position,
  });
  if (!updated) {
    throw domainConflictError(
      `Scene revision conflict: expected ${input.expectedRevision}.`
    );
  }
  return {
    entityType: 'scene',
    entityId: input.sceneId,
    revision: input.expectedRevision + 1,
  };
}

/* ----------------------------------- shot ----------------------------------- */

export async function createShot(
  projectId: string,
  input: {
    sceneId: string;
    description: string;
    durationMs?: number | null;
    position?: number;
  }
): Promise<DomainWriteResult> {
  // Parent must exist AND finally belong to this project.
  const parent = await resolveSceneForProjectOrThrow(projectId, input.sceneId);
  const description = trim(input.description);
  if (!description) {
    throw domainValidationError('Shot description must be non-empty.');
  }

  const shotRow = await inDrizzleTransaction(async (tx) => {
    const position =
      input.position === undefined
        ? await storyRepository.maxShotPosition(input.sceneId, tx)
        : input.position;
    return storyRepository.insertShot(
      {
        sceneId: input.sceneId,
        position,
        description,
        durationMs: input.durationMs === undefined ? null : input.durationMs,
      },
      tx
    );
  });
  return {
    entityType: 'shot',
    entityId: shotRow.id,
    revision: shotRow.revision,
  };
}

export async function updateShot(
  projectId: string,
  input: {
    shotId: string;
    expectedRevision: number;
    description?: string | null;
    durationMs?: number | null;
    position?: number;
  }
): Promise<DomainWriteResult> {
  const ownership = await storyRepository.resolveShotOwnership(
    projectId,
    input.shotId
  );
  if (!ownership) {
    throw domainNotFoundError('Shot not found in this project.');
  }
  const existing = await storyRepository.getShotByIdForProject(
    projectId,
    input.shotId
  );
  if (!existing) {
    throw domainNotFoundError('Shot not found in this project.');
  }
  const description =
    input.description === undefined
      ? existing.description
      : trim(input.description);
  if (!description) {
    throw domainValidationError('Shot description must be non-empty.');
  }
  const position =
    input.position === undefined ? existing.position : input.position;

  const updated = await storyRepository.updateShotByIdAndRevision({
    id: input.shotId,
    sceneIdOfShot: ownership.sceneId,
    expectedRevision: input.expectedRevision,
    description,
    durationMs: input.durationMs,
    position,
  });
  if (!updated) {
    throw domainConflictError(
      `Shot revision conflict: expected ${input.expectedRevision}.`
    );
  }
  return {
    entityType: 'shot',
    entityId: input.shotId,
    revision: input.expectedRevision + 1,
  };
}

/** Resolve a scene's existence confined to `projectId`, or throw NOT_FOUND. */
async function resolveSceneForProjectOrThrow(
  projectId: string,
  sceneId: string
): Promise<Awaited<ReturnType<typeof storyRepository.resolveSceneOwnership>>> {
  const ownership = await storyRepository.resolveSceneOwnership(
    projectId,
    sceneId
  );
  if (!ownership) {
    throw domainNotFoundError('Scene not found in this project.');
  }
  return ownership;
}
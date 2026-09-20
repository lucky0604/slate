import { createCommandId } from '@/core/commands/contracts';
import { apiJsonGet, apiJsonPost } from '@/lib/api-client';
import type { StoryWorkspaceReadModel } from './workspace-read';
import type { ProjectSnapshotDocument } from '@/core/projects/project-snapshot';

/**
 * Story Workspace client (Phase 2B).
 *
 * The browser-only read/write transport for the Story Workspace. It never
 * imports the DB or the Story repository:
 *
 * - reads go through the project-scoped `story-workspace` read route;
 * - every mutation goes through the shared command route
 *   (`POST /api/app/projects/:projectId/commands`), which funnels into
 *   `persistBeatDesignCommand` → command registry → Story/Scene/Shot domain
 *   service. UI never bypasses the command kernel.
 */

export type DomainWriteResultData = {
  entityType: 'story' | 'scene' | 'shot';
  entityId: string;
  revision: number;
};

export type StoryCommandResult = {
  ok: boolean;
  commandId: string;
  projectId: string;
  origin: string;
  code?: string;
  message?: string;
  revision?: number;
  data?: DomainWriteResultData;
};

export type StoryCommand =
  | { type: 'story.create'; title: string; premise?: string | null }
  | {
      type: 'story.update';
      storyId: string;
      expectedRevision: number;
      title?: string;
      premise?: string | null;
    }
  | {
      type: 'scene.create';
      storyId: string;
      title: string;
      summary?: string | null;
    }
  | {
      type: 'scene.update';
      sceneId: string;
      expectedRevision: number;
      title?: string;
      summary?: string | null;
      position?: number;
    }
  | {
      type: 'shot.create';
      sceneId: string;
      description: string;
      durationMs?: number | null;
    }
  | {
      type: 'shot.update';
      shotId: string;
      expectedRevision: number;
      description?: string;
      durationMs?: number | null;
      position?: number;
    }
  | {
      type: 'shot.delete';
      shotId: string;
      expectedRevision: number;
    };

/**
 * Send a Story/Scene/Shot domain command through the shared command transport.
 * The registry + domain service are the authorities; this only shapes the HTTP.
 */
export async function executeStoryCommand({
  projectId,
  command,
  commandId = createCommandId(),
  idempotencyKey = commandId,
}: {
  projectId: string;
  command: StoryCommand;
  commandId?: string;
  idempotencyKey?: string;
}): Promise<StoryCommandResult> {
  try {
    const result = await apiJsonPost<StoryCommandResult>(
      `/api/app/projects/${encodeURIComponent(projectId)}/commands`,
      {
        commandId,
        idempotencyKey,
        command,
      }
    );
    return result;
  } catch (error) {
    // The command route returns structured failures; surface them as-is.
    if (error && typeof error === 'object' && 'ok' in error) {
      return error as StoryCommandResult;
    }
    throw error;
  }
}

/** Load the project-scoped Story Workspace read model. */
export async function loadStoryWorkspaceModel({
  projectId,
  storyId,
  sceneId,
}: {
  projectId: string;
  storyId?: string | null;
  sceneId?: string | null;
}): Promise<StoryWorkspaceReadModel> {
  const query = new URLSearchParams();
  if (storyId) query.set('story', storyId);
  if (sceneId) query.set('scene', sceneId);
  const suffix = query.toString();
  return apiJsonGet<StoryWorkspaceReadModel>(
    `/api/app/projects/${encodeURIComponent(projectId)}/story-workspace${
      suffix ? `?${suffix}` : ''
    }`
  );
}

/**
 * Load the project's canvas snapshot document. Shot projection cards live in the
 * shared `cards`+`frames` (Phase 2B reuses this existing persistence), so the
 * Story Workspace reads it to know each shot projection's canvas frame.
 */
export async function loadStoryWorkspaceSnapshot(projectId: string): Promise<{
  projectId: string;
  version: number;
  document: ProjectSnapshotDocument;
} | null> {
  try {
    return await apiJsonGet<{
      projectId: string;
      version: number;
      document: ProjectSnapshotDocument;
    }>(`/api/app/projects/${encodeURIComponent(projectId)}/snapshot`);
  } catch {
    return null;
  }
}

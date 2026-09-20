import { createFileRoute } from '@tanstack/react-router';

import { getProject } from '@/core/projects/projects';
import { loadStoryWorkspaceReadModel } from '@/core/story/workspace-read';

/**
 * Read boundary for the Story Workspace (Phase 2B).
 *
 * `GET /api/app/projects/:projectId/story-workspace?story=<storyId>&scene=<sceneId>`
 *
 * Returns the project-scoped Story Workspace read model (stories, loaded story,
 * its scenes ordered by position, and the current scene's shots ordered by
 * position). Every value is resolved through the project parent chain, so a
 * guessed story/scene id can never return rows from another project.
 *
 * This is a read-only route: all mutations go through the command route
 * (`POST /api/app/projects/:projectId/commands`) and the shared command kernel.
 */
async function GET({
  request,
  params,
}: {
  request: Request;
  params: { projectId: string };
}) {
  const { projectId } = params;
  const project = await getProject({ projectId });
  if (!project) {
    return Response.json({ error: 'Project not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const storyId = url.searchParams.get('story')?.trim() || null;
  const sceneId = url.searchParams.get('scene')?.trim() || null;

  const model = await loadStoryWorkspaceReadModel({
    projectId,
    storyId,
    sceneId,
  });

  return Response.json(model);
}

export const Route = createFileRoute(
  '/api/app/projects/$projectId/story-workspace'
)({
  server: {
    handlers: { GET },
  },
});
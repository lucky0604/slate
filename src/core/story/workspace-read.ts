import type { Scene, Shot, Story } from '@/config/db/schema';
import {
  getScene,
  getStory,
  listScenes,
  listProjectShots,
  listShots,
  listStories,
} from './queries';

/**
 * Story Workspace read model (Phase 2B).
 *
 * This is the **read boundary** the UI uses to fetch Story / Scene / Shot data
 * for the Story Workspace. It composes the Phase 2A domain queries into a single
 * project-scoped shape the browser can consume without importing the DB or the
 * Story repository.
 *
 * The read model is a projection of Domain data for display — NOT a new source
 * of truth, and it is never persisted as a document. All queries resolve through
 * the parent chain to `projectId`, so no id can be guessed across a project
 * boundary.
 */

export type StoryWorkspaceStory = Story;
export type StoryWorkspaceScene = Scene;
export type StoryWorkspaceShot = Shot;

export type StoryWorkspaceReadModel = {
  projectId: string;
  stories: StoryWorkspaceStory[];
  /** The requested/selected story, or null when the project has none. */
  story: StoryWorkspaceStory | null;
  /** Scenes of the loaded story, ordered by position. */
  scenes: StoryWorkspaceScene[];
  /** Every shot in the project, used to remove stale projections safely. */
  allShots: StoryWorkspaceShot[];
  /** The current/selected scene's detail and its shots, ordered by position. */
  currentScene: {
    scene: StoryWorkspaceScene | null;
    shots: StoryWorkspaceShot[];
  };
};

/**
 * Load the Story Workspace read model for a project.
 *
 * If `storyId` is omitted, the most recently created story is chosen. If the
 * story has no scenes, `currentScene.scene` is null and `shots` is empty, which
 * the UI turns into an empty state ("Create first scene").
 *
 * If `sceneId` is provided, its scene + shots are loaded only when it belongs to
 * the project (ownership is enforced by the underlying project-scoped queries).
 */
export async function loadStoryWorkspaceReadModel({
  projectId,
  storyId,
  sceneId,
}: {
  projectId: string;
  storyId?: string | null;
  sceneId?: string | null;
}): Promise<StoryWorkspaceReadModel> {
  const stories = await listStories(projectId);
  if (stories.length === 0) {
    return {
      projectId,
      stories: [],
      story: null,
      scenes: [],
      allShots: [],
      currentScene: { scene: null, shots: [] },
    };
  }

  const requestedStory = storyId ? await getStory(projectId, storyId) : null;
  const story = requestedStory ?? stories[0] ?? null;
  if (!story) {
    return {
      projectId,
      stories,
      story: null,
      scenes: [],
      allShots: [],
      currentScene: { scene: null, shots: [] },
    };
  }

  const scenes = await listScenes(projectId, story.id);
  const allShots = await listProjectShots(projectId);
  if (scenes.length === 0) {
    return {
      projectId,
      stories,
      story,
      scenes: [],
      allShots,
      currentScene: { scene: null, shots: [] },
    };
  }

  const scene = sceneId ? await getScene(projectId, sceneId) : null;
  const activeScene = scene ?? scenes[0] ?? null;
  if (!activeScene) {
    return {
      projectId,
      stories,
      story,
      scenes,
      allShots,
      currentScene: { scene: null, shots: [] },
    };
  }

  const shots = await listShots(projectId, activeScene.id);
  return {
    projectId,
    stories,
    story,
    scenes,
    allShots,
    currentScene: { scene: activeScene, shots },
  };
}

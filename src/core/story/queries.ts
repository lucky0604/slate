import { storyRepository } from './repository';
import type { Scene, Shot, Story } from '@/config/db/schema';

/**
 * Story / Scene / Shot read queries (Phase 2A).
 *
 * Reads do not go through the write command path. Every query is project-scoped
 * (either by an owning `projectId` argument or by resolving the id through its
 * parent chain up to the project), so a caller can never read a row from another
 * project merely by guessing an id.
 */

export async function getStory(
  projectId: string,
  storyId: string
): Promise<Story | null> {
  return storyRepository.getStoryByIdForProject(projectId, storyId);
}

export async function listStories(projectId: string): Promise<Story[]> {
  return storyRepository.listStoriesByProject(projectId);
}

export async function getScene(
  projectId: string,
  sceneId: string
): Promise<Scene | null> {
  return storyRepository.getSceneByIdForProject(projectId, sceneId);
}

export async function listScenes(
  projectId: string,
  storyId: string
): Promise<Scene[]> {
  return storyRepository.listScenesByStory(projectId, storyId);
}

export async function getShot(
  projectId: string,
  shotId: string
): Promise<Shot | null> {
  return storyRepository.getShotByIdForProject(projectId, shotId);
}

export async function listShots(
  projectId: string,
  sceneId: string
): Promise<Shot[]> {
  return storyRepository.listShotsByScene(projectId, sceneId);
}
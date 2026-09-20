import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { executeProjectCommand } from '@/core/commands/client';
import type { ProjectSnapshotDocument } from '@/core/projects/project-snapshot';
import { reconcileShotProjections } from '@/core/story/shot-projection';
import {
  executeStoryCommand,
  loadStoryWorkspaceModel,
  loadStoryWorkspaceSnapshot,
  type StoryCommandResult,
} from '@/core/story/client';
import { storyWorkspaceKeys } from '@/core/workspace-lib/app/workspace-query-keys';
import type { Shot } from '@/config/db/schema';

/**
 * Story Workspace state hook (Phase 2B).
 *
 * Holds workspace/navigation state — `currentStoryId`, `currentSceneId`,
 * `selectedShotId` — as pure client state (NOT Domain fields), plus the
 * project-scoped read model and the reconciled shot-projection canvas document.
 *
 * The write path is strict:
 *   Domain mutations  → executeStoryCommand → POST /commands → registry → domain
 *   Projection layout → executeProjectCommand (canvas.apply move/upsert)
 * The hook never imports the DB or the Story repository.
 */
export function useStoryWorkspace(projectId: string) {
  const queryClient = useQueryClient();

  // Navigation / workspace state (client-only, never Domain columns).
  const [currentStoryId, setCurrentStoryId] = useState<string | null>(null);
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);

  // Working projection canvas document (reconciled from Domain shots + snapshot).
  const [projectionDocument, setProjectionDocument] =
    useState<ProjectSnapshotDocument | null>(null);
  const [projectionDiff, setProjectionDiff] = useState<{
    createdProjectionIds: string[];
    removedProjectionIds: string[];
  }>({ createdProjectionIds: [], removedProjectionIds: [] });

  const readModelQuery = useQuery({
    queryKey: storyWorkspaceKeys.model(projectId, currentStoryId, currentSceneId),
    queryFn: () =>
      loadStoryWorkspaceModel({
        projectId,
        storyId: currentStoryId,
        sceneId: currentSceneId,
      }),
  });

  const snapshotQuery = useQuery({
    queryKey: storyWorkspaceKeys.model(projectId, currentStoryId, '__snapshot__'),
    queryFn: () => loadStoryWorkspaceSnapshot(projectId),
    staleTime: 5_000,
  });

  const readModel = readModelQuery.data;

  // Seed navigation state from the read model (first story/scene) only when the
  // user has not explicitly navigated yet.
  const isSeeded = useRef(false);
  useEffect(() => {
    if (!readModel || isSeeded.current) return;
    if (!currentStoryId && readModel.story) {
      setCurrentStoryId(readModel.story.id);
      isSeeded.current = true;
    }
  }, [readModel, currentStoryId]);

  const currentStory = useMemo(
    () => readModel?.stories.find((story) => story.id === currentStoryId) ?? null,
    [readModel, currentStoryId]
  );

  const currentScene = useMemo(() => {
    if (!readModel) return null;
    const scenes = readModel.story?.id === currentStoryId ? readModel.scenes : [];
    if (currentSceneId && scenes.some((scene) => scene.id === currentSceneId)) {
      return scenes.find((scene) => scene.id === currentSceneId) ?? null;
    }
    return scenes[0] ?? readModel.currentScene.scene;
  }, [readModel, currentStoryId, currentSceneId]);

  const currentShots = useMemo<Shot[]>(() => {
    if (readModel?.story?.id !== currentStoryId) return [];
    // readModel is keyed by (story, scene), so currentScene reflects the
    // selected scene; return its ordered shots for the current story.
    return readModel.currentScene.shots;
  }, [readModel, currentStoryId]);

  const knownShotIds = useMemo(
    () => new Set((readModel?.allShots ?? []).map((shot) => shot.id)),
    [readModel]
  );

  // Reconcile the projection document whenever the domain read model, the
  // snapshot, or the active scene changes.
  const reconcile = useCallback(() => {
    if (!currentScene) {
      setProjectionDocument((document) => document ?? null);
      setProjectionDiff({ createdProjectionIds: [], removedProjectionIds: [] });
      return;
    }
    const shots = Object.fromEntries(currentShots.map((shot) => [shot.id, shot]));
    const orderedShotIds = currentShots.map((shot) => shot.id);
    const baseDocument =
      snapshotQuery.data?.document ?? { version: 3, cards: [], frames: {} };
    const result = reconcileShotProjections({
      document: baseDocument,
      shots,
      orderedShotIds,
      knownShotIds,
    });
    setProjectionDocument(result.document);
    setProjectionDiff({
      createdProjectionIds: result.createdProjectionIds,
      removedProjectionIds: result.removedProjectionIds,
    });
  }, [currentScene, currentShots, knownShotIds, snapshotQuery.data]);

  useEffect(() => {
    if (!snapshotQuery.isFetched) return;
    reconcile();
  }, [reconcile, snapshotQuery.isFetched]);

  // Persist newly-created projection cards (idempotent upsert). Runs after a
  // reconcile that produced new projections (e.g. after shot.create / scene
  // refresh). Creates are guarded so repeated effects do not loop.
  const createdPersistedRef = useRef<string[]>([]);
  const removedPersistedRef = useRef<string[]>([]);
  const persistProjectionDiff = useCallback(
    async (
      document: ProjectSnapshotDocument,
      diff: {
        createdProjectionIds: string[];
        removedProjectionIds: string[];
      }
    ) => {
      const previous = createdPersistedRef.current;
      const removed = removedPersistedRef.current;
      const toUpsert = document.cards.filter(
        (card) =>
          card.kind === 'shot' &&
          diff.createdProjectionIds.includes(card.id) &&
          !previous.includes(card.id)
      );
      const toRemove = diff.removedProjectionIds.filter(
        (cardId) => !removed.includes(cardId)
      );
      if (toUpsert.length === 0 && toRemove.length === 0) return;
      const operations = [
        ...toUpsert.map((card) => ({
          type: 'upsert_card' as const,
          card,
          frame: document.frames[card.id],
        })),
        ...toRemove.map((cardId) => ({
          type: 'remove_card' as const,
          cardId,
        })),
      ];
      const result = await executeProjectCommand({
        projectId,
        command: { type: 'canvas.apply' as const, operations },
      });
      if (result.ok) {
        createdPersistedRef.current = [
          ...previous,
          ...toUpsert.map((card) => card.id),
        ];
        removedPersistedRef.current = [...removed, ...toRemove];
        await queryClient.invalidateQueries({
          queryKey: storyWorkspaceKeys.all,
        });
      }
    },
    [projectId, queryClient]
  );

  useEffect(() => {
    if (projectionDocument) {
      void persistProjectionDiff(projectionDocument, projectionDiff);
    }
  }, [projectionDiff, projectionDocument, persistProjectionDiff]);

  const refreshWorkspace = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: storyWorkspaceKeys.all });
  }, [queryClient]);

  const runMutation = useCallback(
    async (command: Parameters<typeof executeStoryCommand>[0]['command']) => {
      const result: StoryCommandResult = await executeStoryCommand({
        projectId,
        command,
      });
      if (result.ok) {
        await refreshWorkspace();
      }
      return result;
    },
    [projectId, refreshWorkspace]
  );

  /* ------------------------------ navigation ------------------------------ */

  const selectStory = useCallback((storyId: string) => {
    setCurrentStoryId(storyId);
    setCurrentSceneId(null);
    setSelectedShotId(null);
  }, []);

  const selectScene = useCallback((sceneId: string) => {
    setCurrentSceneId(sceneId);
    setSelectedShotId(null);
  }, []);

  const selectShot = useCallback((shotId: string) => {
    setSelectedShotId(shotId);
  }, []);

  /* --------------------------------- writes -------------------------------- */

  const createStory = useCallback(
    async (title: string) => {
      const result = await runMutation({
        type: 'story.create',
        title,
      });
      if (result.ok && result.data?.entityId) {
        setCurrentStoryId(result.data.entityId);
        setCurrentSceneId(null);
      }
      return result;
    },
    [runMutation]
  );

  const createScene = useCallback(
    async (title: string) => {
      if (!currentStoryId) return null;
      const result = await runMutation({
        type: 'scene.create',
        storyId: currentStoryId,
        title,
      });
      if (result.ok && result.data?.entityId) {
        setCurrentSceneId(result.data.entityId);
      }
      return result;
    },
    [currentStoryId, runMutation]
  );

  const createShot = useCallback(
    async (description: string) => {
      if (!currentScene) return null;
      const result = await runMutation({
        type: 'shot.create',
        sceneId: currentScene.id,
        description,
      });
      if (result.ok && result.data?.entityId) {
        setSelectedShotId(result.data.entityId);
      }
      return result;
    },
    [currentScene, runMutation]
  );

  const updateSelectedShot = useCallback(
    async (patch: {
      description?: string;
      durationMs?: number | null;
      position?: number;
    }) => {
      if (!selectedShotId) return null;
      const expectedRevision =
        currentShots.find((shot) => shot.id === selectedShotId)?.revision ?? 1;
      return runMutation({
        type: 'shot.update',
        shotId: selectedShotId,
        expectedRevision,
        ...patch,
      });
    },
    [selectedShotId, currentShots, runMutation]
  );

  const deleteShot = useCallback(async () => {
    if (!selectedShotId) return null;
    const shot = currentShots.find((candidate) => candidate.id === selectedShotId);
    if (!shot) return null;
    const result = await runMutation({
      type: 'shot.delete',
      shotId: shot.id,
      expectedRevision: shot.revision,
    });
    if (result.ok) {
      setSelectedShotId(null);
    }
    return result;
  }, [currentShots, runMutation, selectedShotId]);

  const updateScene = useCallback(
    async (
      sceneId: string,
      patch: { title?: string; summary?: string; position?: number }
    ) => {
      const expectedRevision =
        readModel?.scenes.find((scene) => scene.id === sceneId)?.revision ?? 1;
      return runMutation({
        type: 'scene.update',
        sceneId,
        expectedRevision,
        ...patch,
      });
    },
    [readModel, runMutation]
  );

  const moveShotCard = useCallback(
    async (cardId: string, frame: { x: number; y: number; w: number; h: number }) => {
      // Canvas layout only: never writes shot.position or shot.revision.
      setProjectionDocument((document) =>
        document
          ? {
              ...document,
              frames: { ...document.frames, [cardId]: frame },
            }
          : document
      );
      const result = await executeProjectCommand({
        projectId,
        command: {
          type: 'canvas.apply' as const,
          operations: [{ type: 'move_card' as const, cardId, frame }],
        },
      });
      if (result.ok) {
        await queryClient.invalidateQueries({ queryKey: storyWorkspaceKeys.all });
      }
      return result;
    },
    [projectId, queryClient]
  );

  return {
    projectId,
    readModel,
    readModelLoading: readModelQuery.isLoading,
    readModelError: readModelQuery.error,
    snapshot: snapshotQuery.data,
    currentStory,
    currentScene,
    currentShots,
    currentStoryId,
    currentSceneId,
    selectedShotId,
    projectionDocument,
    selectStory,
    selectScene,
    selectShot,
    createStory,
    createScene,
    createShot,
    updateSelectedShot,
    deleteShot,
    updateScene,
    moveShotCard,
    refreshWorkspace,
  };
}

export type StoryWorkspaceState = ReturnType<typeof useStoryWorkspace>;

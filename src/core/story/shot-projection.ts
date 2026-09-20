import { isCanvasShotCard } from '@/core/beatcanvas/canvas-types';
import type {
  CanvasCard,
  CanvasShotCard,
} from '@/core/beatcanvas/canvas-types';
import type {
  ProjectSnapshotDocument,
  ProjectSnapshotShapeFrame,
} from '@/core/projects/project-snapshot';
import type { Shot } from '@/config/db/schema';

/**
 * Shot projection card utilities & reconciliation (Phase 2B).
 *
 * A `shot` card is a thin projection of a Story/Scene/Shot domain shot. This
 * module defines:
 *
 * - the projection card identity (`shot:${shotId}`) and a minimal card factory
 *   from a Domain shot;
 * - `reconcileShotProjections`, a **pure** function that aligns the projection
 *   cards in a project snapshot with the current scene's Domain shots.
 *
 * Reconciliation enforces:
 *
 * - **Existence source of truth = Domain shots.** A missing projection card for
 *   a current-scene shot is inserted. Reconciliation never creates or deletes
 *   Domain shots.
 * - **Idempotency & identity.** One `shotId` maps to at most one primary
 *   projection card. Re-running reconciliation, or switching scenes back and
 *   forth, never duplicates cards.
 * - **Layout preservation.** An already-positioned projection card keeps its
 *   exact `frames[x/y/w/h]`; only genuinely new cards get a deterministic
 *   default position derived from the shot's narrative `position`.
 * - **Scene switch does not destroy other scenes' layouts.** Reconciliation is
 *   scene-scoped to the current scene's shots for *addition*, but it never
 *   removes a projection card whose `shotId` is not in the current scene (that
 *   card belongs to another scene and must be preserved). Orphan cleanup of
 *   globally-invalid shot ids is deliberately deferred; deleting a projection
 *   would risk dropping another scene's layout.
 *
 * The function never writes Domain data: pass a Shot from the read model and
 * only the thin projection fields land on the card. `x/y` live in the snapshot
 * `frames` record (canvas layout), strictly separate from `shot.position`
 * (narrative order).
 */

export const SHOT_CARD_ID_PREFIX = 'shot:';

/** Deterministic projection card id for a domain shot (one id per shotId). */
export const shotProjectionCardId = (shotId: string) =>
  `${SHOT_CARD_ID_PREFIX}${shotId}`;

export type ShotProjectionFactoryInput = Pick<
  Shot,
  'id' | 'position'
> & { description?: string | null };

export const SHOT_CARD_DEFAULT_SIZE = { w: 240, h: 150 };

/** Exported for deterministic layout tests. */
export const SHOT_CARD_ROW_GAP = 40;
export const SHOT_CARD_ROW_HEIGHT = 190;
export const SHOT_CARD_ROW_START_X = 40;

/**
 * Default deterministic placement: shots laid left-to-right in a single row,
 * ordered by their array index (which follows domain `position` order), starting
 * at a fixed origin. No auto-layout engine.
 */
export function defaultShotProjectionFrame(
  shots: ShotProjectionFactoryInput[],
  shot: ShotProjectionFactoryInput
): ProjectSnapshotShapeFrame {
  const index = shots.findIndex((candidate) => candidate.id === shot.id);
  const column = index < 0 ? shot.position : index;
  return {
    x: SHOT_CARD_ROW_START_X + column * (SHOT_CARD_DEFAULT_SIZE.w + SHOT_CARD_ROW_GAP),
    y: SHOT_CARD_ROW_HEIGHT,
    w: SHOT_CARD_DEFAULT_SIZE.w,
    h: SHOT_CARD_DEFAULT_SIZE.h,
  };
}

/** Build a thin projection card from a domain shot. Authoritative data stays in Domain. */
export function buildShotProjectionCard(
  shot: ShotProjectionFactoryInput,
  options: { name?: string } = {}
): CanvasShotCard {
  return {
    id: shotProjectionCardId(shot.id),
    shotId: shot.id,
    kind: 'shot',
    type: 'image',
    name: options.name ?? (shot.description?.trim() || 'Shot'),
    url: null,
    prompt: '',
    referenceCardIds: [],
    workflowTemplateId: null,
    status: 'idle',
    error: null,
    modelId: '',
    aspectRatio: '1:1',
    outputQuality: '1k',
    duration: '5s',
    mode: 'quality',
    variant: 'standard',
    quality: 'standard',
    sourceGenerationId: null,
  };
}

export type ReconcileShotProjectionsInput = {
  /** Current project snapshot (any cards; shot cards are reconciled, others untouched). */
  document: ProjectSnapshotDocument;
  /** Domain shots belonging to the current scene, keyed by id. */
  shots: Record<string, Shot>;
  /** Ordered domain shot ids for the current scene (drives default placement). */
  orderedShotIds: string[];
  /** All live Domain shot ids in the project, when orphan cleanup is desired. */
  knownShotIds?: ReadonlySet<string>;
};

export type ReconcileShotProjectionsResult = {
  /** Next snapshot document with reconciliated shot projection cards. */
  document: ProjectSnapshotDocument;
  /** Ids of projection cards that did not previously exist. */
  createdProjectionIds: string[];
  /** Ids of stale or duplicate projection cards removed from the snapshot. */
  removedProjectionIds: string[];
};

/**
 * Align projection cards with the current scene's Domain shots.
 *
 * Adds missing projections for current-scene shots at a deterministic default
 * position and preserves every existing shot projection (including cards from
 * other scenes) together with its exact frame. Non-shot cards are untouched.
 */
export function reconcileShotProjections({
  document,
  shots,
  orderedShotIds,
  knownShotIds,
}: ReconcileShotProjectionsInput): ReconcileShotProjectionsResult {
  const nonShotCards: CanvasCard[] = [];
  const existingShotCards: CanvasShotCard[] = [];
  const removedProjectionIds: string[] = [];
  for (const card of document.cards) {
    if (isCanvasShotCard(card)) {
      if (knownShotIds && !knownShotIds.has(card.shotId)) {
        removedProjectionIds.push(card.id);
        continue;
      }
      existingShotCards.push(card);
    } else {
      nonShotCards.push(card);
    }
  }

  // Map existing projections by shotId. If a file ever held duplicate shot
  // projections for one shotId, keep only the first (one shotId -> one projection).
  const existingByShotId = new Map<string, CanvasShotCard>();
  for (const card of existingShotCards) {
    if (!existingByShotId.has(card.shotId)) {
      existingByShotId.set(card.shotId, card);
    } else {
      removedProjectionIds.push(card.id);
    }
  }

  const orderedShots = orderedShotIds
    .map((shotId) => shots[shotId])
    .filter((shot): shot is Shot => Boolean(shot));

  const createdProjectionIds: string[] = [];
  const nextFrames: Record<string, ProjectSnapshotShapeFrame> = {
    ...document.frames,
  };

  for (const shot of orderedShots) {
    const existing = existingByShotId.get(shot.id);
    if (existing) {
      // Keep the existing projection id + layout (idempotent, layout preserved).
      continue;
    }
    const card = buildShotProjectionCard(shot);
    existingByShotId.set(shot.id, card);
    if (!nextFrames[card.id]) {
      nextFrames[card.id] = defaultShotProjectionFrame(orderedShots, shot);
    }
    createdProjectionIds.push(card.id);
  }

  // Preserve every existing shot card (current scene, other scenes, and any
  // legacy cards). Non-shot cards pass through untouched.
  const finalCards: CanvasCard[] = [
    ...nonShotCards,
    ...Array.from(existingByShotId.values()),
  ].sort((left, right) => left.id.localeCompare(right.id));

  // Keep only frames that reference a real card and are well-formed.
  const keepCardIds = new Set(finalCards.map((card) => card.id));
  const frames: Record<string, ProjectSnapshotShapeFrame> = {};
  for (const [cardId, frame] of Object.entries(nextFrames)) {
    if (
      keepCardIds.has(cardId) &&
      frame &&
      typeof frame === 'object' &&
      Number.isFinite(frame.x) &&
      Number.isFinite(frame.y) &&
      Number.isFinite(frame.w) &&
      Number.isFinite(frame.h)
    ) {
      frames[cardId] = frame;
    }
  }

  return {
    document: {
      ...document,
      cards: finalCards,
      frames,
    },
    createdProjectionIds,
    removedProjectionIds,
  };
}

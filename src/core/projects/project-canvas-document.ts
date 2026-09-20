import {
  type CanvasCard,
  type CanvasDraftCard,
  type CanvasGenerationCard,
  type CanvasOutputCard,
  type CanvasShotCard,
  isCanvasDraftCard,
  isCanvasGenerationCard,
  isCanvasOutputCard,
  isCanvasShotCard,
} from '@/core/beatcanvas/canvas-types';

import { isTransientCanvasUrl } from '@/core/beatcanvas/local-references';
import type {
  ProjectSnapshotCamera,
  ProjectSnapshotDocument,
  ProjectSnapshotShapeFrame,
} from './project-snapshot';
import { normalizeProjectSnapshotDocument } from './project-snapshot';

type SnapshotFramesById = Record<string, ProjectSnapshotShapeFrame>;
type NonDraftCanvasCard = CanvasCard & {
  kind: 'asset';
};

export const mergeCanvasRuntimeCardsIntoHistoryDocument = ({
  target,
  current,
}: {
  target: ProjectSnapshotDocument;
  current: ProjectSnapshotDocument;
}): ProjectSnapshotDocument => {
  const nextCardsById = new Map(
    target.cards.map((card) => [card.id, { ...card }] as const)
  );
  const currentCardsById = new Map(
    current.cards.map((card) => [card.id, card] as const)
  );

  for (const currentCard of current.cards) {
    if (currentCard.kind === 'output') {
      nextCardsById.set(currentCard.id, currentCard);
      const sourceConfigCard = currentCard.sourceConfigCardId
        ? currentCardsById.get(currentCard.sourceConfigCardId)
        : null;
      if (sourceConfigCard && !nextCardsById.has(sourceConfigCard.id)) {
        nextCardsById.set(sourceConfigCard.id, sourceConfigCard);
      }
      continue;
    }

    const targetCard = nextCardsById.get(currentCard.id);
    if (
      targetCard?.kind === 'generation' &&
      currentCard.kind === 'generation' &&
      (currentCard.status === 'pending' || currentCard.status === 'processing')
    ) {
      nextCardsById.set(currentCard.id, {
        ...targetCard,
        status: currentCard.status,
        error: currentCard.error,
      });
    }
  }

  const frames = { ...target.frames };
  for (const cardId of nextCardsById.keys()) {
    if (!frames[cardId] && current.frames[cardId]) {
      frames[cardId] = current.frames[cardId];
    }
  }

  return {
    ...target,
    cards: [...nextCardsById.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    frames,
  };
};

export const buildProjectSnapshotDocument = ({
  cardsById,
  framesById,
  camera,
}: {
  cardsById: Record<string, CanvasCard>;
  framesById: SnapshotFramesById;
  camera?: ProjectSnapshotCamera;
}): ProjectSnapshotDocument => {
  const persistableCards = Object.values(cardsById).filter(
    (card) => !isTransientCanvasUrl(card.url)
  );
  const knownCardIds = new Set(persistableCards.map((card) => card.id));
  const cards = persistableCards
    .map((card) => ({
      ...card,
      referenceCardIds: card.referenceCardIds.filter((cardId) =>
        knownCardIds.has(cardId)
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const frames = Object.entries(framesById).reduce<SnapshotFramesById>(
    (accumulator, [cardId, frame]) => {
      if (knownCardIds.has(cardId)) {
        accumulator[cardId] = frame;
      }
      return accumulator;
    },
    {}
  );

  return {
    version: 3,
    cards,
    frames,
    ...(camera ? { camera } : {}),
  };
};

/**
 * Merge Story Shot projections back into a Media Canvas capture without
 * materializing them as Media Canvas cards or nodes. The Story Workspace owns
 * their meaning; Media Canvas only carries their opaque snapshot state so a
 * restore/capture/autosave round-trip remains lossless.
 */
export const mergePreservedShotProjections = ({
  document,
  shotCards,
  shotFrames,
}: {
  document: ProjectSnapshotDocument;
  shotCards: readonly CanvasShotCard[];
  shotFrames: Record<string, ProjectSnapshotShapeFrame>;
}): ProjectSnapshotDocument => {
  if (shotCards.length === 0) return document;

  const cardsById = new Map(document.cards.map((card) => [card.id, card] as const));
  for (const card of shotCards) {
    cardsById.set(card.id, card);
  }

  return normalizeProjectSnapshotDocument({
    ...document,
    cards: [...cardsById.values()],
    frames: { ...document.frames, ...shotFrames },
  });
};

type SnapshotRestoreCard<TCard extends CanvasCard> = {
  card: TCard;
  frame?: ProjectSnapshotShapeFrame;
};

type SnapshotConnector = {
  sourceCardId: string;
  targetCardId: string;
};

export type ProjectSnapshotRestorePlan = {
  assetCards: Array<SnapshotRestoreCard<NonDraftCanvasCard>>;
  draftCards: Array<SnapshotRestoreCard<CanvasGenerationCard>>;
  outputCards: Array<SnapshotRestoreCard<CanvasOutputCard>>;
  /** Shot projection cards (Phase 2B): preserved on restore so no layout is lost. */
  shotCards: Array<SnapshotRestoreCard<CanvasShotCard>>;
  connectors: SnapshotConnector[];
};

export const createProjectSnapshotRestorePlan = (
  document: ProjectSnapshotDocument
): ProjectSnapshotRestorePlan => {
  const outputSourceById = new Map(
    document.cards
      .filter(isCanvasOutputCard)
      .map((card) => [card.id, card.sourceConfigCardId] as const)
  );
  const normalizeVisibleReferences = <TCard extends CanvasCard>(card: TCard) =>
    ({
      ...card,
      referenceCardIds: Array.from(
        new Set(
          card.referenceCardIds.map(
            (referenceCardId) =>
              outputSourceById.get(referenceCardId) ?? referenceCardId
          )
        )
      ),
    }) as TCard;
  const assetCards = document.cards
    .filter(
      (card): card is NonDraftCanvasCard =>
        card.kind === 'asset' &&
        (card.type === 'timeline' ||
          (typeof card.url === 'string' && card.url.length > 0))
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((card) => ({
      card: normalizeVisibleReferences(card),
      frame: document.frames[card.id],
    }));

  const draftCards = document.cards
    .filter(isCanvasGenerationCard)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((card) => ({
      card: normalizeVisibleReferences(card),
      frame: document.frames[card.id],
    }));

  const outputCards = document.cards
    .filter(isCanvasOutputCard)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((card) => ({
      card,
      frame: document.frames[card.id],
    }));

  // Shot projection cards are preserved as-is on restore so a domain-shot
  // projection and its canvas frame never get dropped when another surface
  // (e.g. the media canvas) round-trips the shared snapshot.
  const shotCards = document.cards
    .filter(isCanvasShotCard)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((card) => ({
      card,
      frame: document.frames[card.id],
    }));

  const connectorIds = new Set<string>();
  const connectors: SnapshotConnector[] = [];

  for (const current of [...assetCards, ...draftCards]) {
    for (const referenceCardId of current.card.referenceCardIds) {
      const connectorId = `${referenceCardId}->${current.card.id}`;
      if (connectorIds.has(connectorId)) {
        continue;
      }

      connectorIds.add(connectorId);
      connectors.push({
        sourceCardId: referenceCardId,
        targetCardId: current.card.id,
      });
    }
  }

  return {
    assetCards,
    draftCards,
    outputCards,
    shotCards,
    connectors,
  };
};

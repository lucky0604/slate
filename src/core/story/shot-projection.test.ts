import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectSnapshotDocument } from '@/core/projects/project-snapshot';
import type { Shot } from '@/config/db/schema';
import {
  buildShotProjectionCard,
  reconcileShotProjections,
  shotProjectionCardId,
} from './shot-projection';

const shot = (id: string, position: number, description = 'A shot'): Shot =>
  ({
    id,
    sceneId: 'scene-1',
    position,
    description,
    durationMs: 4000,
    revision: 1,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  }) as Shot;

const emptyDocument = (): ProjectSnapshotDocument => ({
  version: 3,
  cards: [],
  frames: {},
});

test('Domain Shot -> Shot projection card (reconcile creates one card)', () => {
  const base = emptyDocument();
  const result = reconcileShotProjections({
    document: base,
    shots: { s1: shot('s1', 0) },
    orderedShotIds: ['s1'],
  });
  assert.equal(result.createdProjectionIds.length, 1);
  assert.equal(result.createdProjectionIds[0], shotProjectionCardId('s1'));
  const shotCards = result.document.cards.filter(
    (card) => card.kind === 'shot'
  );
  assert.equal(shotCards.length, 1);
  assert.equal(shotCards[0].shotId, 's1');
  // Projection card does NOT carry authoritative domain data.
  assert.equal('description' in shotCards[0], false);
  assert.equal('revision' in shotCards[0], false);
  assert.equal('durationMs' in shotCards[0], false);
  assert.equal('position' in shotCards[0], false);
});

test('projection card is a thin projection: no authoritative shot fields copied', () => {
  const card = buildShotProjectionCard(shot('s1', 0, 'A dramatic close-up'));
  assert.equal(card.kind, 'shot');
  assert.equal(card.shotId, 's1');
  assert.equal(card.id, shotProjectionCardId('s1'));
  // Layout lives in snapshot frames, not the card.
  assert.equal('x' in card, false);
  assert.equal('y' in card, false);
});

test('idempotent reconcile: repeated reconcile keeps exactly one projection per shot', () => {
  let document = emptyDocument();
  for (let i = 0; i < 3; i += 1) {
    const result = reconcileShotProjections({
      document,
      shots: { s1: shot('s1', 0), s2: shot('s2', 1) },
      orderedShotIds: ['s1', 's2'],
    });
    document = result.document;
  }
  const shotCards = document.cards.filter((card) => card.kind === 'shot');
  assert.equal(shotCards.length, 2);
  assert.deepEqual(
    new Set(shotCards.map((card) => card.shotId)),
    new Set(['s1', 's2'])
  );
});

test('preserves existing layout across domain description updates', () => {
  let document = emptyDocument();
  const first = reconcileShotProjections({
    document,
    shots: { s1: shot('s1', 0, 'old') },
    orderedShotIds: ['s1'],
  });
  document = first.document;
  const cardId = shotProjectionCardId('s1');
  document = {
    ...document,
    frames: { ...document.frames, [cardId]: { x: 500, y: 200, w: 240, h: 150 } },
  };
  // Domain description changes (no layout change) -> layout must be preserved.
  const second = reconcileShotProjections({
    document,
    shots: { s1: shot('s1', 0, 'new description') },
    orderedShotIds: ['s1'],
  });
  const score = second.document.frames[cardId];
  assert.deepEqual(score, { x: 500, y: 200, w: 240, h: 150 });
  assert.equal(second.createdProjectionIds.length, 0);
});

test('reconcile never removes other scenes or unrelated shot projections', () => {
  const base = emptyDocument();
  // A projection for a shot in another scene already exists.
  const otherShotCardId = shotProjectionCardId('other-scene-shot');
  const otherCard = buildShotProjectionCard(shot('other-scene-shot', 0));
  const document: ProjectSnapshotDocument = {
    ...base,
    cards: [otherCard],
    frames: {
      [otherShotCardId]: { x: 1, y: 2, w: 240, h: 150 },
    },
  };
  // Reconcile for the current scene (which does NOT contain other-scene-shot).
  const result = reconcileShotProjections({
    document,
    shots: { s1: shot('s1', 0) },
    orderedShotIds: ['s1'],
  });
  const shotIds = result.document.cards
    .filter((card) => card.kind === 'shot')
    .map((card) => card.shotId);
  assert.ok(shotIds.includes('other-scene-shot'), 'other-scene projection kept');
  assert.ok(shotIds.includes('s1'), 'current-scene projection added');
  // Other scene's frame preserved.
  assert.equal(
    result.document.frames[otherShotCardId].x,
    1,
    'other-scene layout preserved'
  );
});

test('non-shot cards are untouched by reconciliation', () => {
  const assetCard = {
    id: 'asset-1',
    kind: 'asset' as const,
    type: 'image' as const,
    name: 'Poster',
    url: null,
    prompt: '',
    referenceCardIds: [],
    workflowTemplateId: null,
    status: 'idle' as const,
    error: null,
    modelId: '',
    aspectRatio: '1:1' as const,
    outputQuality: '1k' as const,
    duration: '5s' as const,
    mode: 'quality' as const,
    variant: 'standard' as const,
    quality: 'standard' as const,
    sourceGenerationId: null,
  };
  const document: ProjectSnapshotDocument = {
    ...emptyDocument(),
    cards: [assetCard],
    frames: { 'asset-1': { x: 0, y: 0, w: 100, h: 100 } },
  };
  const result = reconcileShotProjections({
    document,
    shots: { s1: shot('s1', 0) },
    orderedShotIds: ['s1'],
  });
  const assetCards = result.document.cards.filter((card) => card.kind === 'asset');
  assert.equal(assetCards.length, 1);
  assert.equal(assetCards[0].id, 'asset-1');
  assert.deepEqual(
    result.document.frames['asset-1'],
    { x: 0, y: 0, w: 100, h: 100 }
  );
});

test('deterministic default placement: ordered by position', () => {
  const result = reconcileShotProjections({
    document: emptyDocument(),
    shots: {
      s1: shot('s1', 0, 'first'),
      s2: shot('s2', 1, 'second'),
      s3: shot('s3', 2, 'third'),
    },
    orderedShotIds: ['s1', 's2', 's3'],
  });
  const frames = result.document.frames;
  const x0 = frames[shotProjectionCardId('s1')].x;
  const x1 = frames[shotProjectionCardId('s2')].x;
  const x2 = frames[shotProjectionCardId('s3')].x;
  assert.ok(x0 < x1 && x1 < x2, 'shots placed left-to-right in position order');
});

test('known-shot reconciliation removes deleted and duplicate projections only', () => {
  const primary = buildShotProjectionCard(shot('s1', 0));
  const duplicate = { ...primary, id: 'shot:s1:duplicate' };
  const orphan = buildShotProjectionCard(shot('deleted', 1));
  const document: ProjectSnapshotDocument = {
    ...emptyDocument(),
    cards: [primary, duplicate, orphan],
    frames: {
      [primary.id]: { x: 1, y: 2, w: 240, h: 150 },
      [duplicate.id]: { x: 300, y: 2, w: 240, h: 150 },
      [orphan.id]: { x: 600, y: 2, w: 240, h: 150 },
    },
  };

  const result = reconcileShotProjections({
    document,
    shots: { s1: shot('s1', 0) },
    orderedShotIds: ['s1'],
    knownShotIds: new Set(['s1']),
  });

  assert.deepEqual(
    new Set(result.removedProjectionIds),
    new Set([duplicate.id, orphan.id])
  );
  assert.deepEqual(
    result.document.cards.filter((card) => card.kind === 'shot').map((card) => card.id),
    [primary.id]
  );
  assert.equal(result.document.frames[duplicate.id], undefined);
  assert.equal(result.document.frames[orphan.id], undefined);
  assert.deepEqual(result.document.frames[primary.id], {
    x: 1,
    y: 2,
    w: 240,
    h: 150,
  });
});

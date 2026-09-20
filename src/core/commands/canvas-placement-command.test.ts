import assert from 'node:assert/strict';
import test from 'node:test';

import type { CanvasCard } from '@/core/beatcanvas/canvas-types';
import { createEmptyProjectSnapshot } from '@/core/projects/project-snapshot';
import { buildShotProjectionCard } from '@/core/story/shot-projection';

import { applyCanvasOperations } from './canvas-commands';
import { canvasOperationSchema } from './schema';

const makeCard = (
  id: string,
  referenceCardIds: string[] = []
): CanvasCard => ({
  id,
  kind: 'generation',
  type: 'image',
  name: id,
  url: null,
  prompt: '',
  referenceCardIds,
  workflowTemplateId: null,
  status: 'idle',
  error: null,
  modelId: 'gpt-image-2',
  aspectRatio: '1:1',
  outputQuality: '1k',
  duration: '5s',
  mode: 'quality',
  variant: 'standard',
  quality: 'standard',
  sourceGenerationId: null,
});

test('MCP schema exposes one-shot right-of-reference placement defaults', () => {
  const operation = canvasOperationSchema.parse({
    type: 'place_card',
    cardId: 'target',
  });

  assert.equal(operation.type, 'place_card');
  assert.equal(operation.side, 'right');
  assert.equal(operation.offsetIndex, 0);
});

test('place_card lays out a target once and later manual movement stays saved', () => {
  const leftTop = makeCard('left-top');
  const leftBottom = makeCard('left-bottom');
  const target = makeCard('target', [leftTop.id, leftBottom.id]);
  const created = applyCanvasOperations(createEmptyProjectSnapshot(), [
    {
      type: 'upsert_card',
      card: leftTop,
      frame: { x: 20, y: 40, w: 200, h: 100 },
    },
    {
      type: 'upsert_card',
      card: leftBottom,
      frame: { x: 20, y: 220, w: 200, h: 100 },
    },
    {
      type: 'upsert_card',
      card: target,
      frame: { x: 0, y: 0, w: 300, h: 200 },
    },
    { type: 'place_card', cardId: target.id },
  ]);

  assert.deepEqual(created.document.frames[target.id], {
    x: 316,
    y: 80,
    w: 300,
    h: 200,
  });

  const moved = applyCanvasOperations(created.document, [
    {
      type: 'move_card',
      cardId: target.id,
      frame: { x: 900, y: 480, w: 300, h: 200 },
    },
    {
      type: 'set_references',
      cardId: target.id,
      referenceCardIds: [leftTop.id],
    },
    { type: 'upsert_card', card: target },
  ]);

  assert.deepEqual(moved.document.frames[target.id], {
    x: 900,
    y: 480,
    w: 300,
    h: 200,
  });
});

test('canvas removal preserves Story Shot projections unless explicitly authorized', () => {
  const shotCard = buildShotProjectionCard({
    id: 'shot-1',
    position: 0,
    description: 'Projection',
  });
  const source = {
    ...createEmptyProjectSnapshot(),
    cards: [shotCard],
    frames: { [shotCard.id]: { x: 40, y: 190, w: 240, h: 150 } },
  };

  const preserved = applyCanvasOperations(source, [
    { type: 'remove_card', cardId: shotCard.id },
  ]);
  assert.equal(preserved.document.cards.some((card) => card.id === shotCard.id), true);
  assert.deepEqual(preserved.document.frames[shotCard.id], source.frames[shotCard.id]);

  const removed = applyCanvasOperations(
    source,
    [{ type: 'remove_card', cardId: shotCard.id }],
    { allowShotProjectionRemoval: true }
  );
  assert.equal(removed.document.cards.some((card) => card.id === shotCard.id), false);
  assert.equal(removed.document.frames[shotCard.id], undefined);
});

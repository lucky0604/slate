import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import type { CanvasAssetCard } from '@/core/beatcanvas/canvas-types';
import { createTimelineDocument } from '@/core/editor/timeline-document';
import { createEmptyProjectSnapshot } from '@/core/projects/project-snapshot';

import { applyCanvasOperations } from './canvas-commands';
import type {
  CommandHandler,
  CommandRegistry,
} from './registry';
import {
  commandRegistry,
  createCommandId,
  createCommandRegistry,
  executeBeatDesignCommand,
} from './index';

const assetCard: CanvasAssetCard = {
  id: 'asset-card-1',
  assetId: 'asset-1',
  kind: 'asset',
  type: 'video',
  name: 'Scene A',
  url: '/scene-a.mp4',
  prompt: '',
  referenceCardIds: [],
  workflowTemplateId: null,
  status: 'succeeded',
  error: null,
  modelId: '',
  aspectRatio: '16:9',
  outputQuality: '1080p',
  duration: '5s',
  mode: 'quality',
  variant: 'standard',
  quality: 'standard',
  sourceGenerationId: null,
};

const canvasApplyCommand = {
  type: 'canvas.apply' as const,
  operations: [
    {
      type: 'upsert_card' as const,
      card: assetCard,
      frame: { x: 10, y: 20, w: 320, h: 180 },
    },
  ],
};

// --- Test 1: existing Canvas command registry execution --------------------

test('canvas.apply executes through the registry and preserves the direct output', () => {
  const snapshot = createEmptyProjectSnapshot();
  const result = executeBeatDesignCommand({
    envelope: {
      commandId: createCommandId(),
      projectId: 'project-1',
      origin: 'ui',
      command: canvasApplyCommand,
    },
    documents: { canvas: snapshot },
  });

  assert.equal(result.ok, true);

  const expected = applyCanvasOperations(
    snapshot,
    canvasApplyCommand.operations
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data.canvas, expected.document);
    assert.deepEqual(result.changedIds, expected.changedIds);
  }
});

// --- Test 2: existing Editor command registry execution --------------------

test('editor.apply executes through the registry and matches the pure output', () => {
  const timeline = createTimelineDocument({
    projectId: 'project-1',
    name: 'Timeline 1',
  });
  const command = {
    type: 'editor.apply' as const,
    operations: [
      {
        type: 'add_clip' as const,
        clipId: 'clip-a',
        assetId: 'asset-a',
        sourceUrl: '/a.mp4',
        name: 'A',
        sourceType: 'video' as const,
        sourceDuration: 5,
      },
    ],
  };
  const result = executeBeatDesignCommand({
    envelope: {
      commandId: createCommandId(),
      projectId: 'project-1',
      origin: 'ui',
      command,
    },
    documents: { timeline },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.timeline?.duration, 5);
    assert.deepEqual(result.changedIds, ['clip-a']);
  }
});

// --- Test 3: all production command types are registered --------------------

test('all current production command types are registered in the default registry', () => {
  assert.deepEqual(commandRegistry.commandTypes, [
    'canvas.apply',
    'editor.apply',
    'editor.replace_document',
    'editor.validate',
  ]);
  for (const type of commandRegistry.commandTypes) {
    assert.equal(commandRegistry.has(type), true);
    assert.ok(commandRegistry.get(type), `handler present for ${type}`);
  }
});

// --- Test 4: unknown command fails deterministically ------------------------

test('unknown command type fails predictably instead of being ignored', () => {
  const registry = createCommandRegistry();
  const timeline = createTimelineDocument({ projectId: 'p', name: 'T' });
  const result = registry.execute(
    {
      commandId: createCommandId(),
      projectId: 'p',
      origin: 'mcp',
      command: { type: 'unknown.command', payload: {} },
    },
    { timeline }
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'COMMAND_FAILED');
    assert.match(result.message, /unknown\.command/);
  }
});

// --- Test 5: duplicate registration fails fast ------------------------------

test('duplicate command type registration throws instead of shadowing', () => {
  const registry = createCommandRegistry();
  const handler: CommandHandler = {
    commandType: 'test.noop',
    schema: z.object({ type: z.literal('test.noop') }),
    target: 'timeline',
    persist: false,
    execute: () => ({ changedIds: [], data: {} }),
  };
  registry.register(handler);
  assert.throws(
    () => registry.register(handler),
    /already registered for command type "test\.noop"/
  );
});

// --- Test 6: test-only new command extends without touching the executor ----

test('a test-only command type can be added by registration and executed via the registry', () => {
  // A fresh, isolated registry proves the extension point: no central executor
  // switch edit is required to run a brand-new command type.
  const registry: CommandRegistry = createCommandRegistry();

  let captured = '';
  const echoHandler: CommandHandler<z.ZodType<{ type: 'test.echo'; message: string }>> = {
    commandType: 'test.echo',
    schema: z.object({ type: z.literal('test.echo'), message: z.string() }),
    target: 'timeline',
    persist: false,
    execute(_context, command) {
      captured = command.message;
      return { changedIds: [], data: {} };
    },
  };

  registry.register(echoHandler);

  const result = registry.execute(
    {
      commandId: createCommandId(),
      projectId: 'p',
      origin: 'mcp',
      command: { type: 'test.echo', message: 'hello from registry' },
    },
    {}
  );

  assert.equal(result.ok, true);
  assert.equal(captured, 'hello from registry');
});

// --- Test 7: idempotent dispatch produces a stable result -------------------

test('dispatching the same incremental command twice yields the same result', () => {
  const timeline = createTimelineDocument({ projectId: 'p', name: 'T' });
  const command = {
    type: 'editor.apply' as const,
    operations: [{ type: 'set_caption_style' as const, preset: 'bold' as const }],
  };
  const envelope = {
    commandId: createCommandId(),
    projectId: 'p',
    origin: 'ui' as const,
    command,
  };
  const first = executeBeatDesignCommand({ envelope, documents: { timeline } });
  const second = executeBeatDesignCommand({ envelope, documents: { timeline } });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.data.timeline?.captionStyle, 'bold');
    assert.deepEqual(second.data.timeline, first.data.timeline);
  }
});

// --- Test 8: CAS / document precondition is preserved -----------------------

test('canvas commands surface NOT_FOUND when the canvas document is absent', () => {
  const result = executeBeatDesignCommand({
    envelope: {
      commandId: createCommandId(),
      projectId: 'p',
      origin: 'ui',
      command: canvasApplyCommand,
    },
    documents: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'NOT_FOUND');
    assert.match(result.message, /Canvas document was not found/);
  }
});

test('incremental editor commands still surface NOT_FOUND for a missing clip (CAS-era validation)', () => {
  const timeline = createTimelineDocument({ projectId: 'p', name: 'T' });
  const result = executeBeatDesignCommand({
    envelope: {
      commandId: createCommandId(),
      projectId: 'p',
      origin: 'ui',
      command: {
        type: 'editor.apply',
        operations: [
          {
            type: 'trim_clip',
            clipId: 'missing-clip',
            inPoint: 0,
            outPoint: 1,
          },
        ],
      },
    },
    documents: { timeline },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'NOT_FOUND');
  }
});

// --- Test 9: receipts / success-shaped result is preserved ------------------

test('a successful registry execution returns a receipt-shaped success', () => {
  const snapshot = createEmptyProjectSnapshot();
  const commandId = createCommandId();
  const result = executeBeatDesignCommand({
    envelope: {
      commandId,
      projectId: 'p',
      origin: 'mcp',
      command: canvasApplyCommand,
    },
    documents: { canvas: snapshot },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.commandId, commandId);
    assert.equal(result.projectId, 'p');
    assert.equal(result.origin, 'mcp');
    assert.equal(typeof result.changedIds, 'object');
    assert.ok(Array.isArray(result.warnings));
    assert.equal('data' in result, true);
  }
});

// --- Test 10: MCP origin flows through the same registry dispatch -----------

test('an mcp-origin canvas.apply reaches the same handler and returns the same data shape', () => {
  const snapshot = createEmptyProjectSnapshot();
  const ui = executeBeatDesignCommand({
    envelope: {
      commandId: createCommandId(),
      projectId: 'p',
      origin: 'ui',
      command: canvasApplyCommand,
    },
    documents: { canvas: snapshot },
  });
  const mcp = executeBeatDesignCommand({
    envelope: {
      commandId: createCommandId(),
      projectId: 'p',
      origin: 'mcp',
      command: canvasApplyCommand,
    },
    documents: { canvas: createEmptyProjectSnapshot() },
  });
  assert.equal(ui.ok, true);
  assert.equal(mcp.ok, true);
  if (ui.ok && mcp.ok) {
    assert.deepEqual(mcp.data.canvas, ui.data.canvas);
    assert.equal(mcp.origin, 'mcp');
    assert.equal(ui.origin, 'ui');
  }
});

// --- registry primitive surface ---------------------------------------------

test('registry exposes get/has/resolve and rejects unknown resolve', () => {
  const registry: CommandRegistry = createCommandRegistry();
  const handler: CommandHandler = {
    commandType: 'test.noop',
    schema: z.object({ type: z.literal('test.noop') }),
    target: 'timeline',
    persist: false,
    execute: () => ({ changedIds: [], data: {} }),
  };
  registry.register(handler);
  assert.equal(registry.has('test.noop'), true);
  assert.equal(registry.get('test.noop'), handler);
  assert.equal(registry.has('nope'), false);
  assert.equal(registry.get('nope'), undefined);
  assert.throws(() => registry.resolve('nope'), /No command handler/);
  assert.equal(registry.resolve('test.noop'), handler);
  assert.equal(registry.size, 1);
});
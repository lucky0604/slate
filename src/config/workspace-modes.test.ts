import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkspaceMode, workspaceModes } from './workspace-modes';

test('workspace modes expose Studio, Canvas, Editor, Assets, and Story', () => {
  assert.deepEqual(workspaceModes, [
    'studio',
    'canvas',
    'editor',
    'assets',
    'story',
  ]);
  assert.equal(resolveWorkspaceMode('studio'), 'studio');
  assert.equal(resolveWorkspaceMode('canvas'), 'canvas');
  assert.equal(resolveWorkspaceMode('editor'), 'editor');
  assert.equal(resolveWorkspaceMode('assets'), 'assets');
  assert.equal(resolveWorkspaceMode('story'), 'story');
  assert.equal(resolveWorkspaceMode('unknown'), 'canvas');
  assert.equal(resolveWorkspaceMode(undefined), 'canvas');
});

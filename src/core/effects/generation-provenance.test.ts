import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGenerationProvenance } from './generation-provenance';

test('prefers durable identity columns over embedded provenance', () => {
  assert.deepEqual(
    resolveGenerationProvenance({
      providerId: 'provider-a',
      modelId: 'model-a',
      input: { _provider: { id: 'provider-b', modelId: 'model-b' } },
    }),
    { providerId: 'provider-a', modelId: 'model-a' }
  );
});

test('uses embedded provenance only for legacy rows without durable identity', () => {
  assert.deepEqual(
    resolveGenerationProvenance({
      providerId: null,
      modelId: null,
      input: { _provider: { id: 'provider-b', modelId: 'model-b' } },
    }),
    { providerId: 'provider-b', modelId: 'model-b' }
  );
});

test('does not fall back to an active provider when provenance is missing', () => {
  assert.deepEqual(
    resolveGenerationProvenance({
      providerId: null,
      modelId: null,
      input: { model: 'model-a' },
    }),
    { providerId: null, modelId: null }
  );
});

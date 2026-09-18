import assert from 'node:assert/strict';
import test from 'node:test';

import { isUrlAllowedForMediaOutput } from './beatapi-media-url';
import { getGenerationProvider } from '@/core/generation-providers';

import {
  buildOutputStoragePlan,
  shouldRetryOutputStorageSync,
} from './output-storage';

test('provider-owned output URLs do not require a second storage sync', () => {
  assert.equal(
    shouldRetryOutputStorageSync({
      providerStatus: 'succeeded',
      output: { storage_sync_failed: true },
    }),
    false
  );
  assert.equal(
    shouldRetryOutputStorageSync({
      providerStatus: 'processing',
      output: { storage_sync_failed: true },
    }),
    false
  );
  assert.equal(
    shouldRetryOutputStorageSync({
      providerStatus: 'succeeded',
      output: { storage_sync_failed: false },
    }),
    false
  );
});

test('stores video covers as thumbnails without replacing the main output asset', () => {
  assert.deepEqual(
    buildOutputStoragePlan({
      effectType: 1,
      output: {
        video_url: 'https://media.beatapi.io/outputs/task-1/result.mp4',
        cover_url: 'https://media.beatapi.io/outputs/task-1/cover.jpg',
      },
    }),
    [
      {
        url: 'https://media.beatapi.io/outputs/task-1/result.mp4',
        type: 'video',
        role: 'output',
      },
      {
        url: 'https://media.beatapi.io/outputs/task-1/cover.jpg',
        type: 'image',
        role: 'thumbnail',
      },
    ]
  );
});

test('output storage gates media by the generation provider allowlist, not a global BeatAPI host', () => {
  const beatApiAllowlist = getGenerationProvider('beatapi')?.mediaHostAllowlist ?? [];

  // BeatAPI keeps its existing behavior: official media host still passes.
  assert.ok(beatApiAllowlist.includes('media.beatapi.io'));
  assert.equal(
    isUrlAllowedForMediaOutput(
      'https://media.beatapi.io/outputs/task-1/result.mp4',
      beatApiAllowlist
    ),
    true
  );

  // A non-BeatAPI public host is not silently allowed for BeatAPI.
  assert.equal(
    isUrlAllowedForMediaOutput('https://example.com/video.mp4', beatApiAllowlist),
    false
  );

  // Provider isolation: a second provider can allow its own media host.
  const testProviderAllowlist = ['media.example.test'];
  assert.equal(
    isUrlAllowedForMediaOutput(
      'https://media.example.test/output.mp4',
      testProviderAllowlist
    ),
    true
  );
  // …but that provider cannot use the BeatAPI host unless it explicitly allows it.
  assert.equal(
    isUrlAllowedForMediaOutput(
      'https://media.beatapi.io/x.mp4',
      testProviderAllowlist
    ),
    false
  );

  // Default-deny: no declared allowlist allows remote generated media.
  assert.equal(
    isUrlAllowedForMediaOutput('https://media.beatapi.io/x.mp4', []),
    false
  );
});

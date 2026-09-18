import { randomUUID } from 'node:crypto';

import { BaseAdapter } from '@/core/adapters/base-adapter';
import type {
  GenerationProviderDefinition,
  GenerationProviderModelBinding,
} from './contracts';

/**
 * TEST-ONLY completion/immediate-result provider.
 *
 * This exists to prove (Phase 1B) that the shared Generation orchestration
 * supports a provider whose generation completes immediately — `createGeneration`
 * returns `status: 'succeeded'` with no remote task, no polling, and no status
 * endpoint. It is the counterpart to the task/polling-shaped BeatAPI provider.
 *
 * It must NOT appear in the production model picker, user provider settings, or
 * the product catalog. It is deliberately not registered in
 * `src/config/generation-providers.ts` and is only registered inside test
 * setup through `registerGenerationProvider`. The generic core never branches
 * on this provider id — execution behavior is purely a function of the returned
 * `GenerationResult.status` (immediate `succeeded`) and the absence of an
 * optional `checkStatus`.
 */

export const COMPLETION_TEST_PROVIDER_ID = 'completion-test';

/** Controlled test media host trusted by this provider for output persistence. */
export const COMPLETION_TEST_MEDIA_HOST = 'media.example.test';

export const completionTestMediaUrl = (path = 'output'): string =>
  `https://${COMPLETION_TEST_MEDIA_HOST}/${path}/${randomUUID()}.png`;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const readString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export class CompletionTestAdapter extends BaseAdapter {
  createGeneration(input: unknown): Promise<{ status: 'succeeded' | 'failed'; output: unknown; error?: string }> {
    const parsed = asObject(input);
    // `failTestResult` lets the test simulate an immediate failed generation.
    if (parsed.failTestResult === true) {
      return Promise.resolve({
        status: 'failed',
        error: 'completion-test: immediate failure',
        output: { message: 'failed immediately' },
      });
    }
    // `completionResultUrlOverride` lets a test point the output at an
    // arbitrary host (e.g. an unapproved host) to exercise the media allowlist.
    const resultUrl = readString(parsed.completionResultUrlOverride) ?? completionTestMediaUrl();
    return Promise.resolve({
      status: 'succeeded',
      output: {
        model: this.effect.model,
        result_url: resultUrl,
        completion: true,
      },
    });
  }
}

export const COMPLETION_TEST_MODEL_BINDINGS: readonly GenerationProviderModelBinding[] =
  [
    {
      modelId: 'gpt-image-2',
      effectId: 200101,
      upstreamModelId: 'completion-test-image',
      uploadPath: 'none',
      imageBucketName: 'none',
    },
    {
      modelId: 'seedance-2',
      effectId: 200102,
      upstreamModelId: 'completion-test-video',
      uploadPath: 'none',
      imageBucketName: 'none',
    },
  ];

export const completionTestGenerationProvider: GenerationProviderDefinition = {
  id: COMPLETION_TEST_PROVIDER_ID,
  label: 'Completion Test (dev/test only)',
  supports: ['image', 'video'],
  mediaHostAllowlist: [COMPLETION_TEST_MEDIA_HOST],
  modelBindings: COMPLETION_TEST_MODEL_BINDINGS,
  createAdapter: (effect) => new CompletionTestAdapter(effect),
};
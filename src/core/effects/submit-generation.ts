import type { EffectRecord } from '@/core/adapters/base-adapter';
import { createAdapter } from '@/core/adapters/adapter-factory';
import { getEffectById } from '@/core/effects/effects';
import { getWorkspaceEffectRegistryEntryByEffectId } from '@/core/effects/effect-registry';
import { VIDEO_ANALYSIS_MODEL_ID } from '@/core/effects/video-analysis';
import {
  getActiveGenerationProviderId,
  getGenerationModelBinding,
  getGenerationModelBindingByEffectId,
  getGenerationProvider,
  type GenerationProviderModelBinding,
} from '@/core/generation-providers';
import {
  resolveGenerationSubmitTransition,
  resolveProviderTaskId,
} from '@/core/effects/generation-orchestrator';
import { persistEffectOutputIfNeeded } from '@/core/effects/output-storage';
import {
  recordGeneration,
  updateGenerationById,
} from '@/core/effects/record-generation';
import { startBackendPollingForGeneration } from '@/core/effects/server-poller';
import { withGenerationSubmissionLock } from '@/core/effects/generation-submission-lock';
import { resolveAuthorizedProjectReferenceUrls } from '@/core/effects/project-reference-authorization';
import {
  getGenerationPromptConstraints,
  validateGenerationPrompt,
} from '@/core/effects/validation';
import {
  getActiveProject,
  loadProjectWithLatestSnapshot,
} from '@/core/projects/projects';
import {
  completeGenerationUploadIntent,
  consumeGenerationUploadIntent,
  failGenerationUploadIntent,
  getCompletedIntentUploads,
  getGenerationUploadIntentAdmissionState,
  issueGenerationUploadIntent,
} from '@/core/effects/generation-upload-intent';
import {
  linkGenerationAsset,
  linkGenerationInputAssetsByUrls,
  getProjectAssetUrls,
  recordUserAsset,
  type AssetType,
} from '@/core/workspace-lib/assets/user-assets';

export type SubmitEffectGenerationResult = {
  status: number;
  body: Record<string, unknown>;
};

export type SubmitEffectGenerationInput = {
  /**
   * Legacy numeric provider effect reference. Kept for BeatAPI-compatible
   * submissions. Provider-neutral submissions may omit `effectId` and pass
   * `providerId` + `modelId` instead.
   */
  effectId?: number;
  /**
   * Explicit provider id. When absent, the target is resolved through
   * ACTIVE_GENERATION_PROVIDER_ID as legacy compatibility (tagged in the
   * recorded `_provider` provenance so history can recover the real provider).
   */
  providerId?: string | null;
  /** Explicit logical model id (provider-neutral). Requires `providerId`. */
  modelId?: string;
  input?: unknown;
  projectId?: string | null;
  generationIntentId?: string | null;
  requireProject?: boolean;
  metadata?: Record<string, unknown>;
  authorizedReferenceUrls?: string[];
};

/**
 * Resolved, provider-neutral identity for one generation submission.
 *
 * Exactly one explicit identity channel —
 * `providerId + modelId` (preferred) or `effectId` (legacy) — is normalized
 * into this shape. All downstream code (intents, effect/adapter resolution,
 * provenance, output persistence) uses only `providerId` + `modelId` +
 * `binding`; it never re-derives the provider from the active provider.
 */
export type GenerationSubmissionTarget = {
  providerId: string;
  modelId: string;
  upstreamModelId: string;
  effectId: number;
  effect: EffectRecord;
  binding: GenerationProviderModelBinding;
  /**
   * True when this target was resolved through ACTIVE_GENERATION_PROVIDER_ID
   * because the request did not carry an explicit providerId. This is the
   * legacy compatibility boundary, not the primary submission identity.
   */
  fromLegacyActiveProvider: boolean;
};

type TargetResolution =
  | { ok: true; target: GenerationSubmissionTarget }
  | { ok: false; status: number; error: string };

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const getReferencedUrls = (input: Record<string, unknown>) => {
  const urls: string[] = [];
  for (const key of ['image_urls', 'video_urls', 'audio_urls'] as const) {
    if (Array.isArray(input[key])) {
      urls.push(
        ...input[key].filter((item): item is string => typeof item === 'string')
      );
    }
  }
  for (const key of ['image_url', 'video_url', 'audio_url'] as const) {
    if (typeof input[key] === 'string') urls.push(input[key]);
  }
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
};

const assetTypeFromMime = (mimeType: string | null): AssetType => {
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'audio';
  return 'image';
};

async function finalizeIntentUploads({
  intentId,
  generationId,
}: {
  intentId: string;
  generationId: string;
}) {
  const uploads = await getCompletedIntentUploads({ intentId });
  for (const upload of uploads) {
    if (!upload.publicUrl || !upload.objectKey) continue;
    const assetId = await recordUserAsset({
      type: assetTypeFromMime(upload.mimeType),
      source: 'upload',
      assetClass: 'original',
      storageProvider: upload.storageProvider ?? 'beatapi',
      bucket: upload.bucket ?? upload.storageProvider ?? 'beatapi',
      objectKey: upload.objectKey,
      publicUrl: upload.publicUrl,
      filename: upload.filename ?? undefined,
      mimeType: upload.mimeType ?? undefined,
      sizeBytes: upload.sizeBytes ?? undefined,
      metadata: { generationIntentId: intentId },
    });
    await linkGenerationAsset({
      generationId,
      assetId,
      role: 'input',
    });
  }
  await completeGenerationUploadIntent({ intentId, generationId });
}

async function linkInputAssets(
  generationId: string,
  input: Record<string, unknown>
) {
  for (const key of ['image_urls', 'video_urls', 'audio_urls'] as const) {
    const urls = Array.isArray(input[key])
      ? input[key].filter((item): item is string => typeof item === 'string')
      : [];
    if (urls.length) {
      await linkGenerationInputAssetsByUrls({ generationId, urls });
    }
  }
}

/**
 * Resolve a submission to exactly one (provider, logical model) target.
 *
 * Identity is explicit: `providerId + modelId` is the provider-neutral shape.
 * `effectId` remains the legacy BeatAPI-compatible channel. When no
 * `providerId` is supplied, the target is resolved through the active provider
 * — that is legitimate *legacy compatibility*, never the sole identity of an
 * explicit request. The legacy fallback is confined to this boundary and is
 * carried forward in the target so history records the true provider.
 */
async function resolveGenerationSubmissionTarget({
  providerId,
  effectId,
  modelId,
}: {
  providerId?: string | null;
  effectId?: number;
  modelId?: string;
}): Promise<TargetResolution> {
  const explicitProviderId = providerId?.trim() || null;

  if (explicitProviderId && !getGenerationProvider(explicitProviderId)) {
    return {
      ok: false,
      status: 422,
      error: `Generation provider "${explicitProviderId}" is not registered.`,
    };
  }

  // Provider-scoped resolution. Explicit requests scope to the requested
  // provider; legacy requests scope to the active provider.
  const scope = explicitProviderId ?? getActiveGenerationProviderId();
  const provider = getGenerationProvider(scope);
  if (!provider) {
    return {
      ok: false,
      status: 422,
      error: `Generation provider "${scope}" is not registered.`,
    };
  }
  const fromLegacyActiveProvider = !explicitProviderId;

  const normalizedModelId = modelId?.trim() || null;
  const hasEffectId = Number.isFinite(effectId);

  // Preferred neutral identity: providerId + modelId.
  let resolvedEffectId: number | null = null;
  if (normalizedModelId) {
    const binding = getGenerationModelBinding({
      modelId: normalizedModelId,
      providerId: scope,
    });
    if (!binding) {
      return {
        ok: false,
        status: 404,
        error: explicitProviderId
          ? `Model "${normalizedModelId}" is not available from provider "${explicitProviderId}".`
          : `Model "${normalizedModelId}" is not available from the active provider.`,
      };
    }
    resolvedEffectId = binding.effectId;
  } else if (hasEffectId) {
    resolvedEffectId = effectId as number;
  } else {
    return {
      ok: false,
      status: 400,
      error: 'providerId + modelId (or legacy effectId) is required.',
    };
  }

  // Resolve the effect and confirm the model binding inside the chosen
  // provider. Never falls back to a different provider's binding.
  const binding = getGenerationModelBindingByEffectId({
    effectId: resolvedEffectId,
    providerId: scope,
  });
  if (!binding) {
    return { ok: false, status: 404, error: 'Model not found' };
  }
  const effect = await getEffectById(resolvedEffectId, scope);
  if (
    !effect ||
    (!getWorkspaceEffectRegistryEntryByEffectId(
      resolvedEffectId,
      scope
    ) &&
      binding.modelId !== VIDEO_ANALYSIS_MODEL_ID)
  ) {
    return { ok: false, status: 404, error: 'Model not found' };
  }
  if (effect.type !== 1 && effect.type !== 2 && effect.type !== 3) {
    return { ok: false, status: 400, error: 'Unsupported task type.' };
  }

  return {
    ok: true,
    target: {
      providerId: scope,
      modelId: binding.modelId,
      upstreamModelId: binding.upstreamModelId,
      effectId: resolvedEffectId,
      effect,
      binding,
      fromLegacyActiveProvider,
    },
  };
}

export async function submitEffectGeneration({
  providerId,
  modelId,
  effectId: requestedEffectId,
  input,
  projectId,
  generationIntentId,
  requireProject = true,
  metadata,
  authorizedReferenceUrls = [],
}: SubmitEffectGenerationInput): Promise<SubmitEffectGenerationResult> {
  const resolution = await resolveGenerationSubmissionTarget({
    providerId,
    effectId: requestedEffectId,
    modelId,
  });
  if (!resolution.ok) {
    return { status: resolution.status, body: { error: resolution.error } };
  }
  const target = resolution.target;
  const { effectId: normalizedEffectId } = target;
  const effect = target.effect;

  const normalizedProjectId = projectId?.trim() || null;
  if (requireProject && !normalizedProjectId) {
    return { status: 400, body: { error: 'projectId is required' } };
  }
  if (normalizedProjectId && !(await getActiveProject({ projectId: normalizedProjectId }))) {
    return { status: 404, body: { error: 'Project not found' } };
  }

  const rawInput = asObject(input);
  const { callBackUrl: _callback, callbackUrl: _callbackLower, ...safeInput } = rawInput;
  const promptConstraints = getGenerationPromptConstraints({
    modelId: effect.model,
    provider: effect.provider,
  });
  const prompt = validateGenerationPrompt(
    typeof safeInput.prompt === 'string' ? safeInput.prompt : '',
    promptConstraints
  );
  if (!prompt.ok) {
    return {
      status: 400,
      body: {
        error:
          prompt.code === 'PROMPT_TOO_LONG'
            ? `Prompt must be ${prompt.maxChars} characters or fewer.`
            : 'Prompt is required.',
      },
    };
  }

  const adapterInput = { ...safeInput, prompt: prompt.trimmedPrompt };
  const normalizedIntentId = generationIntentId?.trim() || '';
  if (!normalizedProjectId || !normalizedIntentId) {
    return {
      status: 400,
      body: { error: 'A generation intent is required.' },
    };
  }
  const recordedInput = {
    ...adapterInput,
    ...(metadata ? { _source: metadata } : {}),
    _provider: {
      id: target.providerId,
      modelId: target.modelId,
      upstreamModelId: target.upstreamModelId,
      effectId: normalizedEffectId,
      // Only present on legacy requests: signals the provider came from
      // ACTIVE_GENERATION_PROVIDER_ID and not an explicit request identity.
      ...(target.fromLegacyActiveProvider
        ? { fromLegacyActiveProvider: true }
        : {}),
    },
  };
  const admission = await withGenerationSubmissionLock<
    | { result: SubmitEffectGenerationResult }
    | { generationId: string; intentId: string }
  >(async () => {
    const referencedUrls = getReferencedUrls(adapterInput);
    if (
      referencedUrls.some(
        (url) => url.startsWith('blob:') || url.startsWith('data:')
      )
    ) {
      return {
        result: {
          status: 400,
          body: {
            error:
              'A connected file is only available in this page. Re-add it and generate again.',
          },
        } satisfies SubmitEffectGenerationResult,
      };
    }
    const [projectAssetUrls, projectState] = await Promise.all([
      getProjectAssetUrls({
        projectId: normalizedProjectId,
        urls: referencedUrls,
      }),
      loadProjectWithLatestSnapshot({ projectId: normalizedProjectId }),
    ]);
    const authorizedProjectUrls = resolveAuthorizedProjectReferenceUrls({
      referencedUrls,
      projectAssetUrls,
      snapshot: projectState?.snapshot,
    });
    authorizedProjectUrls.push(
      ...authorizedReferenceUrls.filter((url) => referencedUrls.includes(url))
    );
    let admittedIntentId = normalizedIntentId;
    let intent = await consumeGenerationUploadIntent({
      intentId: admittedIntentId,
      projectId: normalizedProjectId,
      effectId: normalizedEffectId,
      referencedUrls,
      authorizedProjectUrls,
    });
    let intentState = intent
      ? null
      : await getGenerationUploadIntentAdmissionState({
          intentId: admittedIntentId,
          projectId: normalizedProjectId,
          effectId: normalizedEffectId,
        });
    if (
      !intent &&
      intentState?.status === 'expired' &&
      intentState.refreshableWithoutUploads
    ) {
      await failGenerationUploadIntent({ intentId: admittedIntentId });
      admittedIntentId = await issueGenerationUploadIntent({
        projectId: normalizedProjectId,
        effectId: normalizedEffectId,
        expectedUploadCount: 0,
      });
      intent = await consumeGenerationUploadIntent({
        intentId: admittedIntentId,
        projectId: normalizedProjectId,
        effectId: normalizedEffectId,
        referencedUrls,
        authorizedProjectUrls,
      });
      intentState = intent
        ? null
        : await getGenerationUploadIntentAdmissionState({
            intentId: admittedIntentId,
            projectId: normalizedProjectId,
            effectId: normalizedEffectId,
          });
    }
    if (!intent) {
      // Only retire an otherwise valid pending intent that failed reference
      // authorization. A submitting intent may belong to an in-flight paid
      // request, while an incomplete one may still have uploads finishing.
      if (intentState?.status === 'ready') {
        await failGenerationUploadIntent({ intentId: admittedIntentId });
      }
      const failure =
        intentState?.status === 'used'
          ? {
              code: 'GENERATION_ALREADY_SUBMITTED',
              error:
                'This generation was already submitted. Check History before trying again.',
            }
          : intentState?.status === 'incomplete'
            ? {
                code: 'GENERATION_REFERENCES_PREPARING',
                error:
                  'A reference file is still being prepared. Wait a moment and try Generate again.',
              }
            : intentState?.status === 'ready'
              ? {
                  code: 'GENERATION_REFERENCE_NOT_AUTHORIZED',
                  error:
                    'A reference is no longer available in this canvas. Re-add it and try Generate again.',
                }
              : {
                  code: 'GENERATION_REQUEST_CHANGED',
                  error:
                    'The generation request changed before submission. Try Generate again.',
                };
      return {
        result: {
          status: 409,
          body: failure,
        } satisfies SubmitEffectGenerationResult,
      };
    }

    const generationId = await recordGeneration({
      projectId: normalizedProjectId,
      effectId: normalizedEffectId,
      providerId: target.providerId,
      modelId: target.modelId,
      status: 'pending',
      input: recordedInput,
    });
    if (!generationId) {
      await failGenerationUploadIntent({ intentId: admittedIntentId });
      return {
        result: {
          status: 500,
          body: { error: 'Could not create generation.' },
        } satisfies SubmitEffectGenerationResult,
      };
    }
    return { generationId, intentId: admittedIntentId };
  });
  if ('result' in admission) return admission.result;
  const { generationId, intentId } = admission;

  try {
    await linkInputAssets(generationId, adapterInput);
    const result = await createAdapter(effect).createGeneration(adapterInput);
    const providerError = 'error' in result ? result.error ?? null : null;
    const transition = resolveGenerationSubmitTransition({
      generationId,
      providerStatus: result.status,
      providerTaskId: resolveProviderTaskId(result.output),
      providerOutput: result.output,
      providerError,
    });
    const output =
      result.status === 'succeeded'
        ? await persistEffectOutputIfNeeded({
            output: transition.output,
            wmTaskId: generationId,
            effectId: normalizedEffectId,
            effectType: effect.type,
            providerId: target.providerId,
          })
        : transition.output;
    if (result.status === 'failed') {
      await failGenerationUploadIntent({ intentId });
    } else {
      await finalizeIntentUploads({
        intentId,
        generationId,
      });
    }
    await updateGenerationById({
      id: generationId,
      status: transition.publicStatus,
      output,
      error: transition.error,
    });
    if (transition.publicStatus === 'pending' || transition.publicStatus === 'processing') {
      startBackendPollingForGeneration({
        wmTaskId: generationId,
        effectId: normalizedEffectId,
      });
    }
    return {
      status: 200,
      body: {
        success: transition.publicStatus === 'succeeded',
        status: transition.publicStatus,
        wmTaskId: generationId,
        output,
        error: transition.publicStatus === 'failed' ? providerError ?? 'Generation failed.' : null,
      },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Generation failed';
    await failGenerationUploadIntent({ intentId });
    await updateGenerationById({ id: generationId, status: 'failed', error: message });
    return { status: 500, body: { error: message } };
  }
}

import type { BaseAdapter, EffectRecord } from '@/core/adapters/base-adapter';

export type GenerationMediaCapability = 'image' | 'video' | 'audio' | 'analysis';

export type GenerationProviderModelBinding = {
  /** Stable BeatDesign product model id. */
  modelId: string;
  /** Provider-local numeric id retained for existing DB/API compatibility. */
  effectId: number;
  /** Provider model name sent upstream. */
  upstreamModelId: string;
  uploadPath: string;
  imageBucketName: string;
  upstreamModelByVariant?: Readonly<Record<string, string>>;
};

export type GenerationProviderDefinition = {
  id: string;
  label: string;
  supports: readonly GenerationMediaCapability[];
  modelBindings: readonly GenerationProviderModelBinding[];
  /**
   * Hostnames this provider is trusted to generate output media on. Used by
   * output-storage as the per-provider allowlist before a remote generated URL
   * is downloaded and persisted as a project Asset. Exact hostname matches only.
   * An empty/absent allowlist is default-deny: remote generated media is not
   * auto-persisted until the provider explicitly trusts a host.
   */
  mediaHostAllowlist?: readonly string[];
  createAdapter: (effect: EffectRecord) => BaseAdapter;
  assertConfigured?: () => Promise<void>;
  validateInput?: (effect: EffectRecord, input: Record<string, unknown>) => void;
};

export type GenerationProviderRegistrar = (
  provider: GenerationProviderDefinition
) => void;

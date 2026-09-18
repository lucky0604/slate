type GenerationProvenanceInput = {
  providerId?: unknown;
  modelId?: unknown;
  input?: unknown;
};

export type GenerationProvenance = {
  providerId: string | null;
  modelId: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const readString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * Resolve the provider/model identity recorded for a generation.
 *
 * Durable history columns are authoritative. The embedded `_provider` object
 * is only a compatibility fallback for rows written before those columns
 * existed. This helper intentionally has no active-provider fallback: a
 * missing identity must remain unresolved rather than being re-attributed.
 */
export const resolveGenerationProvenance = ({
  providerId,
  modelId,
  input,
}: GenerationProvenanceInput): GenerationProvenance => {
  const embedded = asRecord(asRecord(input)?._provider);
  return {
    providerId: readString(providerId) ?? readString(embedded?.id),
    modelId: readString(modelId) ?? readString(embedded?.modelId),
  };
};

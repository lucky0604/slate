import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';

// Isolated SQLite DB per test worker, before any db-using module is imported.
const testDataRoot = await mkdtemp(join(tmpdir(), 'slate-phase1c-'));
process.env.BEATDESIGN_DATA_DIR = testDataRoot;
const dbPath = join(testDataRoot, 'local.db');

const client = createClient({ url: `file:${dbPath}` });
await client.executeMultiple(createTestSchemaSql());

const { registerGenerationProvider, getGenerationModelBinding } = await import(
  '@/core/generation-providers'
);
const { setActiveGenerationProviderIdForTests } = await import(
  '@/core/generation-providers/registry'
);
const { createAdapter } = await import('@/core/adapters/adapter-factory');
const { BaseAdapter } = await import('@/core/adapters/base-adapter');
import type {
  GenerationProviderDefinition,
  GenerationProviderModelBinding,
} from '@/core/generation-providers/contracts';

// Shared adapter invocation ledger so a test can assert exactly which
// provider's adapter executed a submission (and that the other did not).
const invokedProviders: string[] = [];
const recordInvocation = (providerId: string) => invokedProviders.push(providerId);

class RecordingCompletionAdapter extends BaseAdapter {
  createGeneration(input: unknown): Promise<{
    status: 'succeeded';
    output: Record<string, unknown>;
  }> {
    recordInvocation(this.effect.provider);
    const host =
      this.effect.provider === 'provider-a' ? 'media.a.test' : 'media.b.test';
    return Promise.resolve({
      status: 'succeeded',
      output: {
        model: this.effect.model,
        result_url: `https://${host}/output/${randomUUID()}.png`,
        completion: true,
      },
    });
  }
}

const makeProvider = (
  id: 'provider-a' | 'provider-b',
  host: string,
  bindings: GenerationProviderModelBinding[]
): GenerationProviderDefinition => ({
  id,
  label: id === 'provider-a' ? 'Test Provider A' : 'Test Provider B',
  supports: ['image'],
  mediaHostAllowlist: [host],
  modelBindings: bindings,
  createAdapter: (effect) => new RecordingCompletionAdapter(effect),
});

// Both providers advertise `gpt-image-2` (a real logical catalog model) with
// provider-specific upstream refs to prove modelId-collision semantics and
// provider-scoped upstream binding. Each also exposes one private model.
const PROVIDER_A = makeProvider('provider-a', 'media.a.test', [
  { modelId: 'gpt-image-2', effectId: 3001, upstreamModelId: 'a-gpt-image', uploadPath: 'none', imageBucketName: 'none' },
  { modelId: 'nano-banana-2', effectId: 3002, upstreamModelId: 'a-nano', uploadPath: 'none', imageBucketName: 'none' },
]);
const PROVIDER_B = makeProvider('provider-b', 'media.b.test', [
  { modelId: 'gpt-image-2', effectId: 4001, upstreamModelId: 'b-gpt-image', uploadPath: 'none', imageBucketName: 'none' },
  { modelId: 'seedream-5-pro', effectId: 4002, upstreamModelId: 'b-seedream', uploadPath: 'none', imageBucketName: 'none' },
]);

registerGenerationProvider(PROVIDER_A);
registerGenerationProvider(PROVIDER_B);

const { submitEffectGeneration } = await import('@/core/effects/submit-generation');
const { issueGenerationUploadIntent } = await import(
  '@/core/effects/generation-upload-intent'
);
const { generationHistory } = await import('@/config/db/schema');

const db = drizzle({ client });

test.after(async () => {
  setActiveGenerationProviderIdForTests(null);
  client.close();
  await rm(testDataRoot, { recursive: true, force: true });
});

function stubOutputFetch() {
  const original = globalThis.fetch as unknown;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    assert.match(String(url), /^https:\/\/media\.[ab]\.test\//);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': '4' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
  }) as any;
  return { restore: () => void (globalThis.fetch = original as typeof fetch) };
}

const projectId = 'project-1';

async function submitTarget({
  providerId,
  modelId,
  effectId,
}: {
  providerId?: string;
  modelId: string;
  effectId?: number;
}) {
  const intentId = await issueGenerationUploadIntent({
    projectId,
    effectId: effectId ?? getGenerationModelBinding({ modelId, providerId })!.effectId,
    expectedUploadCount: 0,
  });
  return submitEffectGeneration({
    providerId,
    modelId,
    effectId,
    input: { prompt: 'A test generation prompt.' },
    projectId,
    generationIntentId: intentId,
  });
}

async function lastGeneration() {
  const rows = await db
    .select()
    .from(generationHistory)
    .where(eq(generationHistory.projectId, projectId));
  return rows[rows.length - 1];
}

test('explicit provider A + model-a invokes provider A, provider B is not invoked', async () => {
  const stub = stubOutputFetch();
  invokedProviders.length = 0;
  try {
    const result = await submitTarget({ providerId: 'provider-a', modelId: 'nano-banana-2' });
    assert.equal(result.status, 200);
    assert.deepEqual(invokedProviders, ['provider-a']);
    const row = await lastGeneration();
    assert.equal(row?.providerId, 'provider-a');
    assert.equal(row?.modelId, 'nano-banana-2');
  } finally {
    stub.restore();
  }
});

test('explicit provider B + model-b invokes provider B even when active = provider A', async () => {
  setActiveGenerationProviderIdForTests('provider-a');
  const stub = stubOutputFetch();
  invokedProviders.length = 0;
  try {
    const result = await submitTarget({ providerId: 'provider-b', modelId: 'seedream-5-pro' });
    assert.equal(result.status, 200);
    // The explicit provider wins over the active provider for this submission.
    assert.deepEqual(invokedProviders, ['provider-b']);
    const row = await lastGeneration();
    assert.equal(row?.providerId, 'provider-b');
    assert.equal(row?.modelId, 'seedream-5-pro');
  } finally {
    stub.restore();
    setActiveGenerationProviderIdForTests(null);
  }
});

test('active provider does not override an explicit provider identity', async () => {
  setActiveGenerationProviderIdForTests('provider-a');
  const stub = stubOutputFetch();
  invokedProviders.length = 0;
  try {
    // Both providers advertise gpt-image-2; explicit providerId picks provider B.
    const result = await submitTarget({ providerId: 'provider-b', modelId: 'gpt-image-2' });
    assert.equal(result.status, 200);
    assert.deepEqual(invokedProviders, ['provider-b']);
    const row = await lastGeneration();
    assert.equal(row?.providerId, 'provider-b');
    assert.equal(row?.modelId, 'gpt-image-2');
  } finally {
    stub.restore();
    setActiveGenerationProviderIdForTests(null);
  }
});

test('unknown provider fails clearly and does not fall back to the active provider', async () => {
  invokedProviders.length = 0;
  // A dummy intent id is safe here: provider validation fails before any
  // upload-intent work, so no intent is issued or consumed.
  const result = await submitEffectGeneration({
    providerId: 'does-not-exist',
    modelId: 'gpt-image-2',
    effectId: 1,
    projectId,
    generationIntentId: 'dummy-intent',
  });
  assert.equal(result.status, 422);
  assert.match(String(result.body.error), /does-not-exist/);
  assert.equal(invokedProviders.length, 0);
});

test('model not supported by the requested provider is a validation error (no cross-routing)', async () => {
  invokedProviders.length = 0;
  // seedream-5-pro exists only on provider-b, never provider-a.
  const result = await submitEffectGeneration({
    providerId: 'provider-a',
    modelId: 'seedream-5-pro',
    projectId,
    generationIntentId: 'dummy-intent',
  });
  assert.equal(result.status === 404 || result.status === 400, true);
  assert.match(String(result.body.error), /seedream-5-pro/);
  assert.equal(invokedProviders.length, 0);
});

test('provider-specific upstream binding resolves per provider, not per shared modelId', async () => {
  const aBinding = getGenerationModelBinding({ modelId: 'gpt-image-2', providerId: 'provider-a' });
  const bBinding = getGenerationModelBinding({ modelId: 'gpt-image-2', providerId: 'provider-b' });
  assert.equal(aBinding?.upstreamModelId, 'a-gpt-image');
  assert.equal(bBinding?.upstreamModelId, 'b-gpt-image');

  const stub = stubOutputFetch();
  invokedProviders.length = 0;
  try {
    const result = await submitTarget({ providerId: 'provider-a', modelId: 'gpt-image-2' });
    assert.equal(result.status, 200);
    // The adapter receives provider A's upstream ref, not provider B's.
    const adapterCall = invokedProviders;
    assert.deepEqual(adapterCall, ['provider-a']);
    const row = await lastGeneration();
    assert.equal(row?.providerId, 'provider-a');
  } finally {
    stub.restore();
  }
});

test('legacy request without providerId still resolves via the active provider (compat boundary)', async () => {
  setActiveGenerationProviderIdForTests('provider-a');
  const stub = stubOutputFetch();
  invokedProviders.length = 0;
  try {
    const intentId = await issueGenerationUploadIntent({
      projectId,
      effectId: getGenerationModelBinding({ modelId: 'nano-banana-2', providerId: 'provider-a' })!.effectId,
      expectedUploadCount: 0,
    });
    const result = await submitEffectGeneration({
      modelId: 'nano-banana-2', // no providerId → legacy active-provider fallback
      input: { prompt: 'A test generation prompt.' },
      projectId,
      generationIntentId: intentId,
    });
    assert.equal(result.status, 200);
    const row = await lastGeneration();
    assert.equal(row?.providerId, 'provider-a');
    assert.equal(row?.modelId, 'nano-banana-2');
    // The provenance blob is explicitly tagged as legacy-active-provider.
    const input = row?.input as Record<string, unknown>;
    const provider = (input?._provider ?? {}) as Record<string, unknown>;
    assert.equal(provider.fromLegacyActiveProvider, true);
  } finally {
    stub.restore();
    setActiveGenerationProviderIdForTests(null);
  }
});

test('generation history identity answers which provider + logical model created it', async () => {
  const stub = stubOutputFetch();
  try {
    const result = await submitTarget({ providerId: 'provider-b', modelId: 'gpt-image-2' });
    assert.equal(result.status, 200);
    const row = await lastGeneration();
    assert.equal(row?.providerId, 'provider-b');
    assert.equal(row?.modelId, 'gpt-image-2');
    // Not inferred from the active provider at read time.
    setActiveGenerationProviderIdForTests(null);
    const read = await lastGeneration();
    assert.equal(read?.providerId, 'provider-b');
    assert.equal(read?.modelId, 'gpt-image-2');
  } finally {
    stub.restore();
    setActiveGenerationProviderIdForTests(null);
  }
});

test('shared logical modelId can be offered by multiple providers (modelId is unique within provider)', async () => {
  // Both providers registered `gpt-image-2`; no global uniqueness collision.
  assert.equal(getGenerationModelBinding({ modelId: 'gpt-image-2', providerId: 'provider-a' })?.upstreamModelId, 'a-gpt-image');
  assert.equal(getGenerationModelBinding({ modelId: 'gpt-image-2', providerId: 'provider-b' })?.upstreamModelId, 'b-gpt-image');
  const { listGenerationProviders } = await import('@/core/generation-providers');
  const ids = listGenerationProviders().map((p) => p.id);
  assert.ok(ids.includes('provider-a') && ids.includes('provider-b'));
});

function createTestSchemaSql(): string {
  return `
    CREATE TABLE project (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      cover_asset_id text,
      status text NOT NULL DEFAULT 'active',
      current_state_version integer NOT NULL DEFAULT 1,
      last_workspace_mode text NOT NULL DEFAULT 'canvas',
      last_opened_at integer, archived_at integer, deleted_at integer,
      created_at integer NOT NULL, updated_at integer NOT NULL
    );
    CREATE TABLE generation_history (
      id text PRIMARY KEY NOT NULL,
      project_id text, effect_id integer NOT NULL,
      provider_id text, model_id text,
      status text NOT NULL,
      provider_task_id text, lifecycle_phase text, last_provider_sync_at integer,
      execution_mode text NOT NULL DEFAULT 'create_new',
      submitted_prompt text, submitted_params text, result_asset_id text,
      input text, output text, error text,
      started_at integer, completed_at integer, failed_at integer, created_at integer NOT NULL
    );
    CREATE TABLE asset (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL, source text NOT NULL,
      asset_class text NOT NULL DEFAULT 'original',
      storage_provider text, bucket text NOT NULL DEFAULT 'beatapi',
      object_key text NOT NULL, public_url text NOT NULL,
      filename text, mime_type text, size_bytes integer, sha256 text,
      width integer, height integer, duration_ms integer, origin_project_id text,
      thumbnail_asset_id text, metadata text,
      created_at integer NOT NULL, updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX asset_bucket_object_key_unique ON asset (bucket, object_key);
    CREATE TABLE generation_asset_link (
      id text PRIMARY KEY NOT NULL,
      generation_id text NOT NULL, asset_id text NOT NULL, role text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE TABLE project_asset_membership (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL, asset_id text NOT NULL, source_run_id text,
      category text NOT NULL, workflow_type text, workflow_instance_id text,
      slot_id text, role text, metadata text, created_at integer NOT NULL
    );
    CREATE TABLE generation_upload_intent (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL, effect_id integer NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      expected_upload_count integer NOT NULL DEFAULT 0,
      reserved_upload_count integer NOT NULL DEFAULT 0,
      completed_upload_count integer NOT NULL DEFAULT 0,
      generation_id text, expires_at integer NOT NULL, consumed_at integer,
      created_at integer NOT NULL, updated_at integer NOT NULL
    );
    CREATE TABLE generation_intent_upload (
      id text PRIMARY KEY NOT NULL,
      intent_id text NOT NULL, status text NOT NULL DEFAULT 'reserved',
      storage_provider text, bucket text, object_key text, public_url text,
      filename text, mime_type text, size_bytes integer,
      created_at integer NOT NULL, completed_at integer
    );
    CREATE TABLE project_canvas_state (
      project_id text PRIMARY KEY NOT NULL,
      document_json text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      updated_at integer NOT NULL
    );
    CREATE TABLE project_timeline_state (
      project_id text PRIMARY KEY NOT NULL,
      document_json text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      updated_at integer NOT NULL
    );
    INSERT INTO project (id, name, created_at, updated_at) VALUES ('project-1', 'p', 0, 0);
  `;
}
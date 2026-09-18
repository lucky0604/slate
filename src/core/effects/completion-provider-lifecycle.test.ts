import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { and, eq } from 'drizzle-orm';

// Point the shared SQLite singleton at an isolated temp DB before any
// db-using module is imported. `node --test` gives each test file its own
// worker process, so this does not affect other test files.
const testDataRoot = await mkdtemp(join(tmpdir(), 'slate-phase1b-'));
process.env.BEATDESIGN_DATA_DIR = testDataRoot;
const dbPath = join(testDataRoot, 'local.db');

const client = createClient({ url: `file:${dbPath}` });
await client.executeMultiple(createTestSchemaSql());

const { registerGenerationProvider } = await import('@/core/generation-providers');
const { completionTestGenerationProvider } = await import(
  '@/core/generation-providers/completion-test-provider'
);
const { createAdapter } = await import('@/core/adapters/adapter-factory');

// Register the test-only completion provider into the shared registry. This is
// the intended test/DI seam; it is never wired into production config.
registerGenerationProvider(completionTestGenerationProvider);

const { resolveGenerationSubmitTransition, resolveProviderTaskId } = await import(
  '@/core/effects/generation-orchestrator'
);
const { persistEffectOutputIfNeeded } = await import('@/core/effects/output-storage');
const { recordGeneration, getGenerationById, updateGenerationById } = await import(
  '@/core/effects/record-generation'
);
const { syncGeneration } = await import('@/core/effects/generation-sync');
const {
  userAsset,
  generationAssetLink,
  projectAssetMembership,
} = await import('@/config/db/schema');
const { BEATAPI_PROVIDER_ID, beatApiGenerationProvider } = await import(
  '@/core/generation-providers/beatapi-provider'
);

test.after(async () => {
  client.close();
  await rm(testDataRoot, { recursive: true, force: true });
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
    INSERT INTO project (id, name, created_at, updated_at) VALUES ('project-1', 'p', 0, 0);
  `;
}

const db = drizzle({ client });

async function resolveTestEffect(modelId: 'gpt-image-2' | 'seedance-2') {
  const provider = completionTestGenerationProvider;
  const binding = provider.modelBindings.find((item) => item.modelId === modelId)!;
  return {
    effect: {
      id: binding.effectId,
      name: modelId,
      type: modelId === 'gpt-image-2' ? 2 : 1,
      model: binding.upstreamModelId,
      version: null,
      linkName: modelId,
      description: null,
      platform: provider.id,
      api: null,
      provider: provider.id,
      inputSchema: {},
    },
    effectId: binding.effectId,
  };
}

test('A/C: completion provider immediate success is persisted to a project Asset', async () => {
  // Stub out the real network download of the generated output.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    assert.match(String(url), /^https:\/\/media\.example\.test\//);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': '4' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
  }) as any;

  try {
    const { effect, effectId } = await resolveTestEffect('gpt-image-2');
    const generationId = await recordGeneration({
      projectId: 'project-1',
      effectId,
      status: 'pending',
      input: { prompt: 'a completion image', _provider: { id: effect.provider } },
    });
    assert.ok(generationId);

    const adapter = createAdapter(effect);
    const result = await adapter.createGeneration({ prompt: 'a completion image' });

    // The completion provider returns succeeded with a media URL but no remote task id.
    assert.equal(result.status, 'succeeded');
    assert.equal(resolveProviderTaskId(result.output), null);
    assert.equal('checkStatus' in adapter, false);

    const transition = resolveGenerationSubmitTransition({
      generationId,
      providerStatus: result.status,
      providerTaskId: resolveProviderTaskId(result.output),
      providerOutput: result.output,
      providerError: 'error' in result ? result.error ?? null : null,
    });
    assert.equal(transition.publicStatus, 'succeeded');

    const output = await persistEffectOutputIfNeeded({
      output: transition.output,
      wmTaskId: generationId,
      effectId,
      effectType: effect.type,
      providerId: effect.provider,
    });
    await updateGenerationById({ id: generationId, status: 'succeeded', output });

    const generation = await getGenerationById({ id: generationId });
    assert.equal(generation?.status, 'succeeded');
    assert.equal(generation?.providerTaskId, null);

    const links = await db
      .select({ assetId: generationAssetLink.assetId, role: generationAssetLink.role })
      .from(generationAssetLink)
      .where(eq(generationAssetLink.generationId, generationId));
    assert.ok(links.some((link: { role: string }) => link.role === 'output'));

    const assetId = (output as Record<string, unknown>).assetIds as string[];
    assert.ok(Array.isArray(assetId) && assetId.length === 1);
    const assets = await db
      .select({
        id: userAsset.id,
        source: userAsset.source,
        assetClass: userAsset.assetClass,
        originProjectId: userAsset.originProjectId,
      })
      .from(userAsset)
      .where(eq(userAsset.id, assetId[0]));
    assert.equal(assets.length, 1);
    assert.equal(assets[0].source, 'provider');
    assert.equal(assets[0].assetClass, 'generated');
    assert.equal(assets[0].originProjectId, 'project-1');

    const membership = await db
      .select()
      .from(projectAssetMembership)
      .where(
        and(
          eq(projectAssetMembership.projectId, 'project-1'),
          eq(projectAssetMembership.assetId, assetId[0])
        )
      );
    assert.equal(membership.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('B: a completion provider is never polled — no checkStatus, no remote task id', async () => {
  const { effect } = await resolveTestEffect('gpt-image-2');
  const generationId = await recordGeneration({
    projectId: 'project-1',
    effectId: effect.id,
    status: 'succeeded',
    input: { prompt: 'done', _provider: { id: effect.provider } },
  });
  assert.ok(generationId);

  const adapter = createAdapter(effect) as any;
  // The completion adapter does not implement the optional checkStatus hook.
  assert.equal(typeof adapter.checkStatus, 'undefined');
  // A completion provider carries no remote task id on its output.
  const result = await adapter.createGeneration({ prompt: 'done' });
  assert.equal(result.status, 'succeeded');
  assert.equal(resolveProviderTaskId(result.output), null);

  // syncGeneration must short-circuit for a terminal completion generation and
  // never reach a status endpoint / checkStatus.
  const synced = await syncGeneration({ wmTaskId: generationId, effectId: effect.id });
  assert.equal(synced.ok, true);
  assert.equal(synced.generation?.providerTaskId, null);
});

test('sync uses durable provider identity and rejects rows without provenance', async () => {
  const { effect } = await resolveTestEffect('gpt-image-2');
  const durableIdentityGenerationId = await recordGeneration({
    projectId: 'project-1',
    effectId: effect.id,
    providerId: effect.provider,
    modelId: 'gpt-image-2',
    status: 'pending',
    input: { prompt: 'durable identity', _provider: { id: 'beatapi' } },
  });
  assert.ok(durableIdentityGenerationId);

  const durableIdentityResult = await syncGeneration({
    wmTaskId: durableIdentityGenerationId,
    effectId: effect.id,
  });
  assert.equal(durableIdentityResult.ok, true);

  const unresolvedGenerationId = await recordGeneration({
    projectId: 'project-1',
    effectId: effect.id,
    status: 'pending',
    input: { prompt: 'missing identity' },
  });
  assert.ok(unresolvedGenerationId);

  assert.deepEqual(
    await syncGeneration({
      wmTaskId: unresolvedGenerationId,
      effectId: effect.id,
    }),
    {
      ok: false,
      status: 409,
      error:
        'Generation provider provenance is missing; synchronization cannot be resolved safely.',
    }
  );
});

test('D: completion output from an untrusted host is rejected and not persisted as an Asset', async () => {
  const { effect } = await resolveTestEffect('gpt-image-2');
  const generationId = await recordGeneration({
    projectId: 'project-1',
    effectId: effect.id,
    status: 'pending',
    input: { prompt: 'x', _provider: { id: effect.provider } },
  });
  assert.ok(generationId);

  const adapter = createAdapter(effect);
  const result = await adapter.createGeneration({
    prompt: 'x',
    // Force the output host to an unapproved provider host.
    completionResultUrlOverride: 'https://media.beatapi.io/outputs/evil.png',
  });
  assert.equal(result.status, 'succeeded');
  assert.match(String((result.output as Record<string, unknown>).result_url), /^https:\/\/media\.beatapi\.io\//);

  const transition = resolveGenerationSubmitTransition({
    generationId,
    providerStatus: result.status,
    providerTaskId: resolveProviderTaskId(result.output),
    providerOutput: result.output,
    providerError: 'error' in result ? result.error ?? null : null,
  });

  // Default-deny media host policy: completion-test only trusts media.example.test.
  await assert.rejects(
    persistEffectOutputIfNeeded({
      output: transition.output,
      wmTaskId: generationId,
      effectId: effect.id,
      effectType: effect.type,
      providerId: effect.provider,
    }),
    /not approved by the generation provider/
  );

  // The rejected run must not produce an asset or a generation-asset link.
  const links = await db
    .select()
    .from(generationAssetLink)
    .where(eq(generationAssetLink.generationId, generationId));
  assert.equal(links.length, 0);
  const remoteHostProviders = await db
    .select()
    .from(userAsset)
    .where(eq(userAsset.source, 'provider'));
  // The only persisted provider asset must be the one created by Test A/C on
  // media.example.test — never the unapproved media.beatapi.io URL.
  assert.ok(
    remoteHostProviders.every((row: { publicUrl: string }) =>
      row.publicUrl.startsWith('/api/app/projects/')
    )
  );
});

test('F: an immediate failed completion never persists output and lands on failed', async () => {
  const { effect } = await resolveTestEffect('seedance-2');
  const generationId = await recordGeneration({
    projectId: 'project-1',
    effectId: effect.id,
    status: 'pending',
    input: { prompt: 'boom', _provider: { id: effect.provider } },
  });
  assert.ok(generationId);

  const adapter = createAdapter(effect);
  const result = await adapter.createGeneration({ prompt: 'boom', failTestResult: true });
  assert.equal(result.status, 'failed');
  assert.equal(resolveProviderTaskId(result.output), null);

  const transition = resolveGenerationSubmitTransition({
    generationId,
    providerStatus: result.status,
    providerTaskId: resolveProviderTaskId(result.output),
    providerOutput: result.output,
    providerError: 'error' in result ? result.error ?? 'failed' : 'failed',
  });
  assert.equal(transition.publicStatus, 'failed');
  // A failed run schedules no polling in the shared orchestration.
  const runningStatuses = ['pending', 'processing'];
  assert.equal(runningStatuses.includes(transition.publicStatus), false);
});

test('G: pending/processing still enter the backend polling gate, succeeded does not', () => {
  const pending = resolveGenerationSubmitTransition({
    generationId: 'g1',
    providerStatus: 'pending',
    providerTaskId: 'task-1',
    providerOutput: { taskId: 'task-1' },
  });
  const processing = resolveGenerationSubmitTransition({
    generationId: 'g2',
    providerStatus: 'processing',
    providerTaskId: 'task-2',
    providerOutput: { taskId: 'task-2' },
  });
  const succeeded = resolveGenerationSubmitTransition({
    generationId: 'g3',
    providerStatus: 'succeeded',
    providerOutput: { result_url: 'https://media.example.test/a.png' },
  });

  // submit-generation only starts startBackendPollingForGeneration when the
  // public status is pending or processing.
  const runningStatuses = ['pending', 'processing'];
  assert.equal(runningStatuses.includes(pending.publicStatus), true);
  assert.equal(runningStatuses.includes(processing.publicStatus), true);
  assert.equal(runningStatuses.includes(succeeded.publicStatus), false);
  assert.equal(succeeded.publicStatus, 'succeeded');
});

test('E: BeatAPI task/polling regression is preserved by the completion work', async () => {
  // BeatAPI keeps its task-shaped provider definition and trusted media host.
  assert.equal(beatApiGenerationProvider.id, BEATAPI_PROVIDER_ID);
  assert.deepEqual(beatApiGenerationProvider.mediaHostAllowlist, ['media.beatapi.io']);
  assert.ok(beatApiGenerationProvider.supports.includes('video'));
  assert.ok(beatApiGenerationProvider.modelBindings.length > 0);

  // Its adapter keeps the optional polling hook.
  const { BeatApiAdapter } = await import('@/core/adapters/beatapi-adapter');
  const beatApiEffect = {
    id: 1,
    name: 'veo-3-1',
    type: 1,
    model: 'veo-3-1',
    version: null,
    linkName: 'veo-3-1',
    description: null,
    platform: 'beatapi',
    api: null,
    provider: 'beatapi',
    inputSchema: {},
  };
  const beatApiAdapter = new BeatApiAdapter(beatApiEffect);
  assert.equal(typeof beatApiAdapter.checkStatus, 'function');

  // A task provider progressing through processing resolves to the polling path.
  const processing = resolveGenerationSubmitTransition({
    generationId: 'beat-1',
    providerStatus: 'processing',
    providerTaskId: 'beat-task-1',
    providerOutput: { taskId: 'beat-task-1' },
  });
  assert.equal(processing.publicStatus, 'processing');
});

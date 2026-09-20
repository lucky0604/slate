import {
  loadProjectTimeline,
  saveProjectTimeline,
} from '@/core/editor/timeline-state';
import {
  loadProjectWithLatestSnapshot,
  saveProjectSnapshot,
} from '@/core/projects/projects';

import { normalizeCommandAssetReferences } from './asset-boundary';
import { timelineCanvasCardId } from './canvas-commands';
import {
  BeatDesignCommandError,
  createCommandFailure,
  createCommandId,
  type BeatDesignCommandEnvelope,
  type BeatDesignCommandOrigin,
  type BeatDesignCommandResult,
} from './contracts';
import {
  commandRegistry,
  executeBeatDesignCommand,
  type BeatDesignCommand,
  type BeatDesignCommandData,
} from './executor';
import {
  loadCommandReceipt,
  loadCommandReceiptRecord,
  storeCommandReceipt,
  type StoredCommandResult,
} from './receipts';
import type { DispatchCommandEnvelope } from './registry';

const inFlightCommands = new Map<
  string,
  {
    commandId: string;
    commandType: string;
    promise: Promise<BeatDesignCommandResult<BeatDesignCommandData>>;
  }
>();

/**
 * An open command shape. Built-in document commands (canvas/editor) are a
 * closed `BeatDesignCommand` union that remains the legacy compatibility
 * surface; relational domain commands (story.* / scene.* / shot.*) are carried
 * as this open `{ type: string } & unknown` shape and validated by their
 * registered handler schema.
 */
type OpenCommand = { type: string } & Record<string, unknown>;

const LEGACY_CMD_TYPES = new Set<BeatDesignCommand['type']>([
  'canvas.apply',
  'editor.apply',
  'editor.replace_document',
  'editor.validate',
]);

const isVersionConflict = (error: unknown) =>
  error instanceof Error &&
  (error.name === 'TimelineVersionConflict' ||
    error.name === 'ProjectSnapshotVersionConflict');

const getConflictRevision = (error: unknown) => {
  if (!error || typeof error !== 'object') return undefined;
  const currentVersion = (error as { currentVersion?: unknown }).currentVersion;
  return typeof currentVersion === 'number' && Number.isFinite(currentVersion)
    ? currentVersion
    : undefined;
};

type PersistCommandInput = {
  projectId: string;
  origin: BeatDesignCommandOrigin;
  commandId: string;
  expectedRevision?: number | null;
  idempotencyKey: string;
  command: OpenCommand;
};

const timelineClipCount = (document: NonNullable<BeatDesignCommandData['timeline']>) =>
  document.tracks.reduce((count, track) => count + track.clips.length, 0);

async function syncExistingTimelineCanvasCard({
  projectId,
  timeline,
}: {
  projectId: string;
  timeline: NonNullable<BeatDesignCommandData['timeline']>;
}) {
  const cardId = timelineCanvasCardId(timeline.id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await loadProjectWithLatestSnapshot({ projectId });
    if (!state || !state.snapshot.cards.some((card) => card.id === cardId)) return null;
    const commandId = createCommandId();
    const envelope: BeatDesignCommandEnvelope<BeatDesignCommand> = {
      commandId,
      projectId,
      origin: 'system',
      expectedRevision: state.snapshotVersion,
      idempotencyKey: commandId,
      command: {
        type: 'canvas.apply',
        operations: [
          {
            type: 'upsert_timeline_node',
            timelineId: timeline.id,
            name: timeline.name,
            durationSec: timeline.duration,
            clipCount: timelineClipCount(timeline),
            lastRenderAssetId: timeline.lastRenderAssetId,
            lastRenderUrl: timeline.lastRenderUrl,
          },
        ],
      },
    };
    const executed = executeBeatDesignCommand({
      envelope,
      documents: { canvas: state.snapshot },
    });
    if (!executed.ok || !executed.data.canvas) {
      return executed.ok ? 'Canvas timeline node could not be synchronized.' : executed.message;
    }
    try {
      await saveProjectSnapshot({
        projectId,
        document: executed.data.canvas,
        baseVersion: state.snapshotVersion,
      });
      return null;
    } catch (error) {
      if (!isVersionConflict(error) || attempt === 2) {
        return error instanceof Error
          ? error.message
          : 'Canvas timeline node could not be synchronized.';
      }
    }
  }
  return 'Canvas timeline node could not be synchronized.';
}

export function validateExternalCommandAssetReferences({
  origin,
  command,
}: {
  origin: BeatDesignCommandOrigin;
  command: OpenCommand;
}) {
  if (origin !== 'mcp' && origin !== 'cli') return;
  if (command.type !== 'canvas.apply') return;
  const canvasCommand = command as Extract<
    BeatDesignCommand,
    { type: 'canvas.apply' }
  >;

  for (const operation of canvasCommand.operations) {
    if (operation.type === 'upsert_card') {
      const { card } = operation;
      if (
        card.kind === 'asset' &&
        card.type !== 'timeline' &&
        !card.assetId
      ) {
        throw new BeatDesignCommandError(
          'INVALID_COMMAND',
          'External Canvas asset cards require a project assetId. Import or generate the asset first.'
        );
      }
      if (card.url && !card.assetId) {
        throw new BeatDesignCommandError(
          'INVALID_COMMAND',
          'External Canvas media URLs must be derived from a project assetId.'
        );
      }
    }

    if (
      operation.type === 'upsert_timeline_node' &&
      operation.lastRenderUrl &&
      !operation.lastRenderAssetId
    ) {
      throw new BeatDesignCommandError(
        'INVALID_COMMAND',
        'External timeline renders require lastRenderAssetId; the server derives lastRenderUrl.'
      );
    }

    if (operation.type === 'remove_card' && operation.cardId.startsWith('shot:')) {
      throw new BeatDesignCommandError(
        'INVALID_COMMAND',
        'External Canvas commands cannot remove Story Shot projections.'
      );
    }
  }
}

async function persistBeatDesignCommandOnce({
  projectId,
  origin,
  commandId,
  expectedRevision,
  idempotencyKey,
  command,
}: PersistCommandInput): Promise<
  BeatDesignCommandResult<BeatDesignCommandData>
> {
  const cached = await loadCommandReceiptRecord({ projectId, idempotencyKey });
  if (cached) {
    if (
      cached.commandId !== commandId ||
      cached.commandType !== command.type
    ) {
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'INVALID_COMMAND',
        message: 'Idempotency key is already bound to a different command.',
      });
    }
    return cached.result;
  }

  if (
    command.type === 'editor.replace_document' &&
    origin !== 'ui' &&
    origin !== 'system'
  ) {
    return createCommandFailure({
      commandId,
      projectId,
      origin,
      code: 'INVALID_COMMAND',
      message:
        'External agents must use editor.apply operations instead of replacing the timeline document.',
    });
  }

  try {
    // Legacy document commands go through the existing asset-reference
    // normalization/validation. Relational domain commands pass through as-is;
    // their payload is validated by the registered handler schema.
    const isLegacy = LEGACY_CMD_TYPES.has(
      command.type as BeatDesignCommand['type']
    );
    if (isLegacy) {
      validateExternalCommandAssetReferences({
        origin,
        command,
      });
    }
    const normalizedCommand = isLegacy
      ? await normalizeCommandAssetReferences({
          projectId,
          command: command as BeatDesignCommand,
        })
      : command;

    const envelope: BeatDesignCommandEnvelope<BeatDesignCommand | OpenCommand> = {
      commandId,
      projectId,
      origin,
      expectedRevision,
      idempotencyKey,
      command: normalizedCommand,
    };

    // Route by the registered handler's persistence kind. Adding a new command
    // type (document or relational domain) only requires a handler — not a
    // growing central `if (type === ...)` dispatcher.
    const handler = commandRegistry.get(normalizedCommand.type);
    if (!handler) {
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'COMMAND_FAILED',
        message: `No command handler is registered for command type "${normalizedCommand.type}".`,
      });
    }

    // Relational domain commands: dispatch through the registry's async path to
    // the Story/Scene/Shot domain service, then persist a durable receipt.
    if (handler.persistence.kind === 'domain') {
      const executed = await commandRegistry.executeAsync(
        envelope as DispatchCommandEnvelope
      );
      if (!executed.ok) return executed;
      return storeCommandReceipt({
        projectId,
        idempotencyKey,
        commandId,
        origin,
        commandType: normalizedCommand.type,
        result: executed as StoredCommandResult,
      });
    }

    // Document commands (Canvas / Timeline) under the existing document CAS.
    let result: BeatDesignCommandResult<BeatDesignCommandData>;
    if (handler.persistence.kind === 'document' && handler.persistence.target === 'canvas') {
      const state = await loadProjectWithLatestSnapshot({ projectId });
      if (!state) {
        return createCommandFailure({
          commandId,
          projectId,
          origin,
          code: 'NOT_FOUND',
          message: 'Project not found',
        });
      }
      const executed = executeBeatDesignCommand({
        envelope: envelope as BeatDesignCommandEnvelope<BeatDesignCommand>,
        documents: { canvas: state.snapshot },
      });
      if (!executed.ok || !executed.data.canvas) return executed;
      const saved = await saveProjectSnapshot({
        projectId,
        document: executed.data.canvas,
        baseVersion:
          typeof expectedRevision === 'number'
            ? expectedRevision
            : state.snapshotVersion,
      });
      result = { ...executed, revision: saved.version };
    } else {
      const timeline = await loadProjectTimeline(projectId);
      const executed = executeBeatDesignCommand({
        envelope: envelope as BeatDesignCommandEnvelope<BeatDesignCommand>,
        documents: { timeline: timeline?.document ?? null },
      });
      if (!executed.ok) return executed;
      if (!handler.persistence.write) {
        // Read/validate-only command (e.g. editor.validate): no new revision,
        // no receipt.
        return { ...executed, revision: timeline?.version };
      }
      if (!executed.data.timeline) return executed;
      const saved = await saveProjectTimeline({
        projectId,
        document: executed.data.timeline,
        baseVersion:
          typeof expectedRevision === 'number'
            ? expectedRevision
            : (timeline?.version ?? null),
      });
      result = {
        ...executed,
        revision: saved.version,
        editorUrl: `/editor/${encodeURIComponent(projectId)}`,
        data: {
          ...executed.data,
          timeline: saved.document,
        },
      };
      const canvasSyncWarning = await syncExistingTimelineCanvasCard({
        projectId,
        timeline: saved.document,
      });
      if (canvasSyncWarning) {
        result = {
          ...result,
          warnings: [
            ...result.warnings,
            `Timeline saved, but its Canvas card is still synchronizing: ${canvasSyncWarning}`,
          ],
        };
      }
    }

    return storeCommandReceipt({
      projectId,
      idempotencyKey,
      commandId,
      origin,
      commandType: normalizedCommand.type,
      result,
    });
  } catch (error) {
    if (error instanceof BeatDesignCommandError) {
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: error.code,
        message: error.message,
      });
    }
    if (isVersionConflict(error)) {
      const cached = await loadCommandReceipt({ projectId, idempotencyKey });
      if (cached) return cached;
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'REVISION_CONFLICT',
        revision: getConflictRevision(error),
        message:
          command.type === 'canvas.apply'
            ? 'Project snapshot version conflict'
            : 'Timeline version conflict',
      });
    }
    if (error instanceof Error && error.message === 'Project not found') {
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'NOT_FOUND',
        message: 'Project not found',
      });
    }
    return createCommandFailure({
      commandId,
      projectId,
      origin,
      code: 'COMMAND_FAILED',
      message:
        error instanceof Error ? error.message : 'The command could not be saved.',
    });
  }
}

export function persistBeatDesignCommand({
  projectId,
  origin,
  commandId = createCommandId(),
  expectedRevision,
  idempotencyKey,
  command,
}: {
  projectId: string;
  origin: BeatDesignCommandOrigin;
  commandId?: string;
  expectedRevision?: number | null;
  idempotencyKey?: string | null;
  command: OpenCommand;
}): Promise<BeatDesignCommandResult<BeatDesignCommandData>> {
  if (
    command.type === 'editor.replace_document' &&
    origin !== 'ui' &&
    origin !== 'system'
  ) {
    return Promise.resolve(
      createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'INVALID_COMMAND',
        message:
          'External agents must use editor.apply operations instead of replacing the timeline document.',
      })
    );
  }
  if (LEGACY_CMD_TYPES.has(command.type as BeatDesignCommand['type'])) {
    try {
      validateExternalCommandAssetReferences({ origin, command });
    } catch (error) {
      if (error instanceof BeatDesignCommandError) {
        return Promise.resolve(
          createCommandFailure({
            commandId,
            projectId,
            origin,
            code: error.code,
            message: error.message,
          })
        );
      }
      throw error;
    }
  }
  const stableIdempotencyKey = idempotencyKey?.trim() || commandId;
  const lockKey = `${projectId}:${stableIdempotencyKey}`;
  const existing = inFlightCommands.get(lockKey);
  if (existing) {
    if (
      existing.commandId !== commandId ||
      existing.commandType !== command.type
    ) {
      return Promise.resolve(
        createCommandFailure({
          commandId,
          projectId,
          origin,
          code: 'INVALID_COMMAND',
          message: 'Idempotency key is already bound to a different command.',
        })
      );
    }
    return existing.promise;
  }

  const promise = persistBeatDesignCommandOnce({
    projectId,
    origin,
    commandId,
    expectedRevision,
    idempotencyKey: stableIdempotencyKey,
    command,
  }).finally(() => {
    if (inFlightCommands.get(lockKey)?.promise === promise) {
      inFlightCommands.delete(lockKey);
    }
  });
  inFlightCommands.set(lockKey, {
    commandId,
    commandType: command.type,
    promise,
  });
  return promise;
}

import type { z } from 'zod';

import {
  BeatDesignCommandError,
  createCommandFailure,
  createCommandSuccess,
  type BeatDesignCommandOrigin,
  type BeatDesignCommandResult,
} from './contracts';
import type {
  BeatDesignCommandData,
  BeatDesignCommandDocuments,
} from './executor';

/**
 * Which authoritative project document a command reads and (when `persist`)
 * writes. The persistence layer uses this to load/save the right document
 * instead of hard-coding `canvas.apply` vs everything-else.
 */
export type CommandDocumentTarget = 'canvas' | 'timeline';

/**
 * Runtime execution context handed to a handler. Mirrors the fields the command
 * kernel already threads through persistence: origin, project, command id, and
 * the current authoritative documents the handler may project onto.
 */
export type CommandExecutionContext = {
  commandId: string;
  projectId: string;
  origin: BeatDesignCommandOrigin;
  documents: BeatDesignCommandDocuments;
};

/**
 * The pure result a handler produces: which entity ids changed and the data
 * (usually the new canvas/timeline document, plus optional diagnostics) to
 * surface on the command receipt.
 */
export type CommandExecutionResult = {
  changedIds: string[];
  data: BeatDesignCommandData;
};

/**
 * Declarative contract for a single command type.
 *
 * - `schema` is the command-specific payload schema (always re-validated before
 *   `execute`), so a command type owns the shape of its own payload.
 * - `target` tells the persistence layer which authoritative document this
 *   command is scoped to.
 * - `persist` marks no-op / read-only commands (e.g. `editor.validate`) that
 *   validate but must not write a new revision.
 * - `execute` reuses the existing pure application functions
 *   (`applyCanvasOperations`, `applyEditorOperations`, ...). Handlers are
 *   declarative entry points, not re-implementations.
 */
export type CommandHandler<TSchema extends z.ZodType = z.ZodType> = {
  commandType: string;
  schema: TSchema;
  target: CommandDocumentTarget;
  persist: boolean;
  execute: (
    context: CommandExecutionContext,
    payload: z.infer<TSchema>
  ) => CommandExecutionResult;
};

/**
 * The generic envelope a registry dispatcher accepts. `type` is the open
 * extension key: any registered command type (built-in or test-only) may be
 * routed without touching a central switch.
 */
export type DispatchCommandEnvelope = {
  commandId: string;
  projectId: string;
  origin: BeatDesignCommandOrigin;
  command: { type: string } & Record<string, unknown>;
};

const commandTypeOf = (envelope: DispatchCommandEnvelope) => envelope.command.type;

/**
 * A command handler registry. Maps `commandType` → handler.
 *
 * Responsibilities are intentionally narrow:
 *   commandType → handler → payload validation → execution.
 * Authorization, undo, MCP generation, OpenAPI, UI form generation, event
 * sourcing, observability, and workflow orchestration are deliberately out of
 * scope and deferred.
 */
export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();

  get size(): number {
    return this.handlers.size;
  }

  get commandTypes(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  has(commandType: string): boolean {
    return this.handlers.has(commandType);
  }

  /**
   * Register a handler for a command type. Duplicate command types fail fast so
   * a built-in like `canvas.apply` can never be silently shadowed.
   */
  register<TSchema extends z.ZodType>(
    handler: CommandHandler<TSchema>
  ): void {
    if (this.handlers.has(handler.commandType)) {
      throw new Error(
        `A command handler is already registered for command type "${handler.commandType}". Duplicate registration is not allowed.`
      );
    }
    this.handlers.set(handler.commandType, handler as CommandHandler);
  }

  get(commandType: string): CommandHandler | undefined {
    return this.handlers.get(commandType);
  }

  /** Remove all handlers. Primarily for isolated test registries. */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Resolve a handler for a command type. Unknown types throw a predictable,
   * testable error instead of silently no-oping or falling back.
   */
  resolve(commandType: string): CommandHandler {
    const handler = this.handlers.get(commandType);
    if (!handler) {
      throw new Error(
        `No command handler is registered for command type "${commandType}".`
      );
    }
    return handler;
  }

  /**
   * Dispatch an envelope through the registered handler. This is the single
   * execution dispatcher — extending the command set never requires editing
   * this method, only registering a new handler.
   */
  execute(
    envelope: DispatchCommandEnvelope,
    documents: BeatDesignCommandDocuments
  ): BeatDesignCommandResult<BeatDesignCommandData> {
    const { commandId, projectId, origin } = envelope;
    const commandType = commandTypeOf(envelope);

    const handler = this.handlers.get(commandType);
    if (!handler) {
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'COMMAND_FAILED',
        message: `No command handler is registered for command type "${commandType}".`,
      });
    }

    const parsed = handler.schema.safeParse(envelope.command);
    if (!parsed.success) {
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'INVALID_COMMAND',
        message:
          parsed.error.issues[0]?.message ?? 'Command payload is invalid.',
      });
    }

    try {
      const executed = handler.execute(
        { commandId, projectId, origin, documents },
        parsed.data
      );
      return createCommandSuccess({
        commandId,
        projectId,
        origin,
        changedIds: executed.changedIds,
        data: executed.data,
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
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'COMMAND_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'The command could not be applied.',
      });
    }
  }
}

/** Create an empty registry. Use this for isolated / test registries. */
export const createCommandRegistry = () => new CommandRegistry();
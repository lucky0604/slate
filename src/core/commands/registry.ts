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
 * Where and how a command is persisted.
 *
 * - `document` commands read/write one authoritative project document (Canvas or
 *   Timeline) under the existing document CAS. `write: false` marks
 *   read/validate-only commands (e.g. `editor.validate`) that never save a new
 *   revision.
 * - `domain` commands are relational: they run against the Slate Story/Scene/
 *   Shot row tables through a domain service. The command kernel never needs to
 *   know which table a domain command touches — it only knows this is a
 *   relational command and dispatches it.
 */
export type CommandPersistence =
  | { kind: 'document'; target: 'canvas' | 'timeline'; write: boolean }
  | { kind: 'domain' };

/**
 * Runtime execution context handed to a handler. Mirrors the fields the command
 * kernel already threads through persistence: origin, project, command id, and
 * the current authoritative documents the handler may project onto. Domain
 * handlers ignore `documents` (their source of truth is relational rows).
 */
export type CommandExecutionContext = {
  commandId: string;
  projectId: string;
  origin: BeatDesignCommandOrigin;
  documents: BeatDesignCommandDocuments;
};

/**
 * The result a handler produces: which entity ids changed and the data to
 * surface on the command receipt. Document handlers return the new doc;
 * domain handlers return a small `{ entityType, entityId, revision }` shape.
 * Domain handlers are async (they touch relational rows); document handlers are
 * synchronous (pure functions over in-memory documents).
 */
export type CommandExecutionResult = {
  changedIds: string[];
  data: BeatDesignCommandData | DomainHandlerData;
};

/** The tiny domain write result surfaced on a receipt (Phase 2A). */
export type DomainHandlerData = {
  entityType: 'story' | 'scene' | 'shot';
  entityId: string;
  revision: number;
};

/**
 * Declarative contract for a single command type.
 *
 * - `schema` is the command-specific payload schema (always re-validated before
 *   `execute`), so a command type owns the shape of its own payload.
 * - `persistence` tells the kernel whether this is a document command (Canvas /
 *   Timeline with `target` + `write`) or a relational domain command.
 * - `execute` reuses the existing pure application functions (document) or a
 *   Slate domain service (domain). Handlers are declarative entry points, not
 *   re-implementations.
 */
export type CommandHandler<TSchema extends z.ZodType = z.ZodType> = {
  commandType: string;
  schema: TSchema;
  persistence: CommandPersistence;
  execute: (
    context: CommandExecutionContext,
    payload: z.infer<TSchema>
  ) => CommandExecutionResult | Promise<CommandExecutionResult>;
};

/**
 * The generic envelope a registry dispatcher accepts. `type` is the open
 * extension key: any registered command type (built-in or new domain type) may
 * be routed without touching a central switch. The payload is `unknown` at this
 * boundary; the registered handler owns payload validation via its schema.
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
   * Synchronously dispatch a command through a registered document handler.
   * Domain (relational) commands must be dispatched with {@link executeAsync};
   * dispatching one here fails deterministically.
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
    if (handler.persistence.kind === 'domain') {
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'COMMAND_FAILED',
        message: `Command type "${commandType}" is a relational domain command and must be dispatched through executeAsync.`,
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
      // Document handlers are synchronous by contract; `executeAsync` handles
      // the (async) relational domain handlers.
      const executed = handler.execute(
        { commandId, projectId, origin, documents },
        parsed.data
      ) as CommandExecutionResult;
      return createCommandSuccess({
        commandId,
        projectId,
        origin,
        changedIds: executed.changedIds,
        data: executed.data as BeatDesignCommandData,
      });
    } catch (error) {
      return mapExecutionError({ error, commandId, projectId, origin });
    }
  }

  /**
   * Async dispatch for relational domain commands. Resolves the registered
   * handler, validates the payload through `handler.schema`, then awaits the
   * domain service write. Unknown types and invalid payloads fail the same way
   * as the synchronous path.
   */
  async executeAsync(
    envelope: DispatchCommandEnvelope
  ): Promise<BeatDesignCommandResult<DomainHandlerData>> {
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
    if (handler.persistence.kind !== 'domain') {
      return createCommandFailure({
        commandId,
        projectId,
        origin,
        code: 'COMMAND_FAILED',
        message: `Command type "${commandType}" is a document command; dispatch it synchronously.`,
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
      const executed = await handler.execute(
        { commandId, projectId, origin, documents: {} },
        parsed.data
      );
      return createCommandSuccess({
        commandId,
        projectId,
        origin,
        changedIds: executed.changedIds,
        data: executed.data as DomainHandlerData,
      });
    } catch (error) {
      return mapExecutionError({ error, commandId, projectId, origin });
    }
  }
}

function mapExecutionError({
  error,
  commandId,
  projectId,
  origin,
}: {
  error: unknown;
  commandId: string;
  projectId: string;
  origin: BeatDesignCommandOrigin;
}): BeatDesignCommandResult<never> {
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

/** Create an empty registry. Use this for isolated / test registries. */
export const createCommandRegistry = () => new CommandRegistry();
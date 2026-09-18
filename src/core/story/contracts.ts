import { BeatDesignCommandError } from '@/core/commands/contracts';

/**
 * Slate Story / Scene / Shot domain contracts (Phase 2A).
 *
 * These are the write outcomes surfaced on command receipts. They are kept as a
 * single, small shape instead of one result type per command, so the command
 * result union does not grow for every Story/Scene/Shot command.
 */
export type DomainEntityType = 'story' | 'scene' | 'shot';

/**
 * The result of a relational domain write (create/update). Always carries the
 * created/updated entity id plus the row revision it produced so callers and
 * UI can render the exact state and seed the next expectedRevision.
 */
export type DomainWriteResult = {
  entityType: DomainEntityType;
  entityId: string;
  revision: number;
};

/**
 * Throw inside a domain service to map to the existing command failure codes.
 * Reuses the shared `BeatDesignCommandError`, so domain commands surface
 * NOT_FOUND / REVISION_CONFLICT / VALIDATION through the same error contract as
 * the document commands.
 */
export const domainValidationError = (message: string) =>
  new BeatDesignCommandError('INVALID_COMMAND', message);

export const domainNotFoundError = (message: string) =>
  new BeatDesignCommandError('NOT_FOUND', message);

export const domainConflictError = (message: string) =>
  new BeatDesignCommandError('REVISION_CONFLICT', message);
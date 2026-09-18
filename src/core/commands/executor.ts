import { diagnoseTimeline } from '@/core/editor/timeline-diagnostics';
import type { ProjectSnapshotDocument } from '@/core/projects/project-snapshot';
import type { TimelineDocument } from '@/core/editor/timeline-document';
import { domainCommandHandlers } from '@/core/story/commands';

import type {
  CanvasOperation,
} from './canvas-commands';
import type {
  EditorOperation,
} from './editor-commands';
import type {
  BeatDesignCommandEnvelope,
  BeatDesignCommandResult,
} from './contracts';
import { builtInCommandHandlers } from './handlers';
import {
  createCommandRegistry,
  type CommandHandler,
  type CommandRegistry,
} from './registry';

export type BeatDesignCommand =
  | { type: 'canvas.apply'; operations: CanvasOperation[] }
  | { type: 'editor.apply'; operations: EditorOperation[] }
  | { type: 'editor.replace_document'; document: TimelineDocument }
  | { type: 'editor.validate' };

export type BeatDesignCommandDocuments = {
  canvas?: ProjectSnapshotDocument;
  timeline?: TimelineDocument | null;
};

export type BeatDesignCommandData = BeatDesignCommandDocuments & {
  diagnostics?: ReturnType<typeof diagnoseTimeline>;
};

/**
 * The application-level command handler registry, pre-populated with the current
 * production commands. Command execution is dispatched through this registry;
 * the executor never switches on a growing closed union.
 */
export const commandRegistry: CommandRegistry = createCommandRegistry();

for (const handler of builtInCommandHandlers) {
  commandRegistry.register(handler);
}

// Phase 2A: register the Slate Story/Scene/Shot relational domain commands into
// the same production registry. They are dispatched through the registry's
// async domain path and never grow the closed `BeatDesignCommand` union.
for (const handler of domainCommandHandlers) {
  commandRegistry.register(handler);
}

/**
 * Execute a command through its registered handler. Unknown command types fail
 * through the registry with a predictable error. The `BeatDesignCommand` union
 * remains as a compatibility/type surface; new command types are added by
 * registering a handler, not by extending the union or this function.
 */
export function executeBeatDesignCommand({
  envelope,
  documents,
}: {
  envelope: BeatDesignCommandEnvelope<BeatDesignCommand>;
  documents: BeatDesignCommandDocuments;
}): BeatDesignCommandResult<BeatDesignCommandData> {
  return commandRegistry.execute(envelope, documents);
}

export type { CommandHandler, CommandRegistry };
export { createCommandRegistry } from './registry';

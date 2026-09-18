import { diagnoseTimeline } from '@/core/editor/timeline-diagnostics';

import { BeatDesignCommandError } from '../contracts';
import type { CommandHandler } from '../registry';
import { editorValidateHandlerSchema } from '../schema';

/**
 * `editor.validate` — a read/validate command. It produces timeline diagnostics
 * without writing a new revision (`persist: false`), so the persistence layer
 * skips the CAS save for it.
 */
export const editorValidateHandler: CommandHandler<
  typeof editorValidateHandlerSchema
> = {
  commandType: 'editor.validate',
  schema: editorValidateHandlerSchema,
  target: 'timeline',
  persist: false,
  execute(context, _command) {
    if (!context.documents.timeline) {
      throw new BeatDesignCommandError(
        'NOT_FOUND',
        'Timeline document was not found.'
      );
    }
    return {
      changedIds: [context.documents.timeline.id],
      data: {
        timeline: context.documents.timeline,
        diagnostics: diagnoseTimeline(context.documents.timeline),
      },
    };
  },
};
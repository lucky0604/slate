import { createTimelineDocument } from '@/core/editor/timeline-document';

import { applyEditorOperations } from '../editor-commands';
import type { CommandHandler } from '../registry';
import { editorApplyHandlerSchema } from '../schema';

/**
 * `editor.apply` — applies incremental timeline operations, creating a fresh
 * timeline when none exists yet. Reuses the existing pure `applyEditorOperations`.
 */
export const editorApplyHandler: CommandHandler<
  typeof editorApplyHandlerSchema
> = {
  commandType: 'editor.apply',
  schema: editorApplyHandlerSchema,
  target: 'timeline',
  persist: true,
  execute(context, command) {
    const source =
      context.documents.timeline ??
      createTimelineDocument({
        projectId: context.projectId,
        name: 'Timeline 1',
      });
    const applied = applyEditorOperations(source, command.operations);
    return {
      changedIds: applied.changedIds,
      data: { timeline: applied.document },
    };
  },
};
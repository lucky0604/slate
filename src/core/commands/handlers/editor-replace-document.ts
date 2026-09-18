import { invalidateTimelineRenderIfSourceChanged } from '../editor-commands';
import type { CommandHandler } from '../registry';
import { editorReplaceDocumentHandlerSchema } from '../schema';

/**
 * `editor.replace_document` — replaces the whole timeline document, invalidating
 * stale renders when the assembled content changed. Reuses the existing render
 * invalidation helper; used by the UI for full-document timeline edits.
 */
export const editorReplaceDocumentHandler: CommandHandler<
  typeof editorReplaceDocumentHandlerSchema
> = {
  commandType: 'editor.replace_document',
  schema: editorReplaceDocumentHandlerSchema,
  target: 'timeline',
  persist: true,
  execute(context, command) {
    const document = context.documents.timeline
      ? invalidateTimelineRenderIfSourceChanged({
          previous: context.documents.timeline,
          next: command.document,
        })
      : command.document;
    return {
      changedIds: [document.id],
      data: { timeline: document },
    };
  },
};
import { BeatDesignCommandError } from '../contracts';
import type { CommandHandler } from '../registry';
import { canvasApplyHandlerSchema } from '../schema';
import { applyCanvasOperations } from '../canvas-commands';

/**
 * `canvas.apply` — applies incremental Canvas operations to the project
 * snapshot. Reuses the existing pure `applyCanvasOperations`; the handler is
 * only a declarative entry point.
 */
export const canvasApplyHandler: CommandHandler<
  typeof canvasApplyHandlerSchema
> = {
  commandType: 'canvas.apply',
  schema: canvasApplyHandlerSchema,
  persistence: { kind: 'document', target: 'canvas', write: true },
  execute(context, command) {
    if (!context.documents.canvas) {
      throw new BeatDesignCommandError(
        'NOT_FOUND',
        'Canvas document was not found.'
      );
    }
    const applied = applyCanvasOperations(
      context.documents.canvas,
      command.operations
    );
    return {
      changedIds: applied.changedIds,
      data: { canvas: applied.document },
    };
  },
};
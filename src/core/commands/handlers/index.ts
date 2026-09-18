import type { CommandHandler } from '../registry';

import { canvasApplyHandler } from './canvas-apply';
import { editorApplyHandler } from './editor-apply';
import { editorReplaceDocumentHandler } from './editor-replace-document';
import { editorValidateHandler } from './editor-validate';

/**
 * The current production command catalog. Each entry is a declarative handler
 * that reuses existing pure application logic. Adding a future command type
 * means adding one handler here (and registering it) — not editing a central
 * executor switch.
 */
export const builtInCommandHandlers: CommandHandler[] = [
  canvasApplyHandler,
  editorApplyHandler,
  editorReplaceDocumentHandler,
  editorValidateHandler,
];
import { z } from 'zod';

import {
  CommandHandler,
  type CommandPersistence,
} from '@/core/commands/registry';
import {
  createScene,
  createShot,
  deleteShot,
  createStory,
  updateScene,
  updateShot,
  updateStory,
} from './service';

/**
 * Story / Scene / Shot domain command handlers (Phase 2A).
 *
 * Each handler is a thin bridge: its `schema` validates the payload, its
 * `persistence.kind === 'domain'` tells the kernel this is a relational
 * command, and `execute` delegates to the Story/Scene/Shot domain service.
 * Adding a new domain write never requires editing the kernel or a growing
 * central command union.
 */

const idSchema = z.string().trim().min(1).max(200);
const nonEmptyFieldSchema = z.string().trim().min(1).max(20_000);
const optionalFieldSchema = z.string().trim().max(20_000).nullable().optional();
const positionSchema = z.number().int().min(0);
const expectedRevisionSchema = z.number().int().min(1);

/** Require at least one modifiable field beyond id + expectedRevision. */
function hasMutableField(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(
    (key) =>
      !['type', 'storyId', 'sceneId', 'shotId', 'expectedRevision'].includes(key)
  );
}

/* ---------------------------------- story ---------------------------------- */

export const storyCreateSchema = z
  .object({
    type: z.literal('story.create'),
    title: nonEmptyFieldSchema,
    premise: optionalFieldSchema,
  })
  .strict();

export const storyUpdateSchema = z
  .object({
    type: z.literal('story.update'),
    storyId: idSchema,
    expectedRevision: expectedRevisionSchema,
    title: nonEmptyFieldSchema.optional(),
    premise: optionalFieldSchema,
  })
  .strict()
  .refine(hasMutableField, {
    message: 'Story update must modify at least one field.',
  });

/* ---------------------------------- scene ---------------------------------- */

export const sceneCreateSchema = z
  .object({
    type: z.literal('scene.create'),
    storyId: idSchema,
    title: nonEmptyFieldSchema,
    summary: optionalFieldSchema,
    position: positionSchema.optional(),
  })
  .strict();

export const sceneUpdateSchema = z
  .object({
    type: z.literal('scene.update'),
    sceneId: idSchema,
    expectedRevision: expectedRevisionSchema,
    title: nonEmptyFieldSchema.optional(),
    summary: optionalFieldSchema,
    position: positionSchema.optional(),
  })
  .strict()
  .refine(hasMutableField, {
    message: 'Scene update must modify at least one field.',
  });

/* ---------------------------------- shot ----------------------------------- */

export const shotCreateSchema = z
  .object({
    type: z.literal('shot.create'),
    sceneId: idSchema,
    description: nonEmptyFieldSchema,
    durationMs: z.number().int().positive().nullable().optional(),
    position: positionSchema.optional(),
  })
  .strict();

export const shotUpdateSchema = z
  .object({
    type: z.literal('shot.update'),
    shotId: idSchema,
    expectedRevision: expectedRevisionSchema,
    description: nonEmptyFieldSchema.optional(),
    durationMs: z.number().int().positive().nullable().optional(),
    position: positionSchema.optional(),
  })
  .strict()
  .refine(hasMutableField, {
    message: 'Shot update must modify at least one field.',
  });

export const shotDeleteSchema = z
  .object({
    type: z.literal('shot.delete'),
    shotId: idSchema,
    expectedRevision: expectedRevisionSchema,
  })
  .strict();

const domainPersistence: CommandPersistence = { kind: 'domain' };

export const storyCreateHandler: CommandHandler<typeof storyCreateSchema> = {
  commandType: 'story.create',
  schema: storyCreateSchema,
  persistence: domainPersistence,
  async execute(context, command) {
    const result = await createStory(context.projectId, {
      title: command.title,
      premise: command.premise,
    });
    return { changedIds: [result.entityId], data: result };
  },
};

export const storyUpdateHandler: CommandHandler<typeof storyUpdateSchema> = {
  commandType: 'story.update',
  schema: storyUpdateSchema,
  persistence: domainPersistence,
  async execute(context, command) {
    const result = await updateStory(context.projectId, {
      storyId: command.storyId,
      expectedRevision: command.expectedRevision,
      title: command.title,
      premise: command.premise,
    });
    return { changedIds: [result.entityId], data: result };
  },
};

export const sceneCreateHandler: CommandHandler<typeof sceneCreateSchema> = {
  commandType: 'scene.create',
  schema: sceneCreateSchema,
  persistence: domainPersistence,
  async execute(context, command) {
    const result = await createScene(context.projectId, {
      storyId: command.storyId,
      title: command.title,
      summary: command.summary,
      position: command.position,
    });
    return { changedIds: [result.entityId], data: result };
  },
};

export const sceneUpdateHandler: CommandHandler<typeof sceneUpdateSchema> = {
  commandType: 'scene.update',
  schema: sceneUpdateSchema,
  persistence: domainPersistence,
  async execute(context, command) {
    const result = await updateScene(context.projectId, {
      sceneId: command.sceneId,
      expectedRevision: command.expectedRevision,
      title: command.title,
      summary: command.summary,
      position: command.position,
    });
    return { changedIds: [result.entityId], data: result };
  },
};

export const shotCreateHandler: CommandHandler<typeof shotCreateSchema> = {
  commandType: 'shot.create',
  schema: shotCreateSchema,
  persistence: domainPersistence,
  async execute(context, command) {
    const result = await createShot(context.projectId, {
      sceneId: command.sceneId,
      description: command.description,
      durationMs: command.durationMs,
      position: command.position,
    });
    return { changedIds: [result.entityId], data: result };
  },
};

export const shotUpdateHandler: CommandHandler<typeof shotUpdateSchema> = {
  commandType: 'shot.update',
  schema: shotUpdateSchema,
  persistence: domainPersistence,
  async execute(context, command) {
    const result = await updateShot(context.projectId, {
      shotId: command.shotId,
      expectedRevision: command.expectedRevision,
      description: command.description,
      durationMs: command.durationMs,
      position: command.position,
    });
    return { changedIds: [result.entityId], data: result };
  },
};

export const shotDeleteHandler: CommandHandler<typeof shotDeleteSchema> = {
  commandType: 'shot.delete',
  schema: shotDeleteSchema,
  persistence: domainPersistence,
  async execute(context, command) {
    const result = await deleteShot(context.projectId, {
      shotId: command.shotId,
      expectedRevision: command.expectedRevision,
    });
    return { changedIds: [result.entityId], data: result };
  },
};

/** The production Story/Scene/Shot domain command catalog (Phase 2A). */
export const domainCommandHandlers: CommandHandler[] = [
  storyCreateHandler,
  storyUpdateHandler,
  sceneCreateHandler,
  sceneUpdateHandler,
  shotCreateHandler,
  shotUpdateHandler,
  shotDeleteHandler,
];

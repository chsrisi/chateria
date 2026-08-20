import { z } from 'zod';

/**
 * WebSocket frames arrive as untrusted JSON, so every field is parsed rather
 * than cast. The inferred type is structurally assignable to the protocol's
 * ClientFrame union.
 */

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('room:subscribe'), roomId: positiveId }),
  z.object({ type: z.literal('room:unsubscribe'), roomId: positiveId }),
  z.object({ type: z.literal('typing:start'), roomId: positiveId }),
  z.object({
    type: z.literal('message:send'),
    body: z.string(),
    roomId: positiveId.nullish(),
    conversationId: positiveId.nullish(),
    clientNonce: z.string().max(64).optional(),
  }),
]);

export type ParsedClientFrame = z.infer<typeof clientFrameSchema>;

export const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
});

export const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const createDmSchema = z.object({
  userId: positiveId,
});

import { z } from 'zod';

import { HookConfigSchema, IsmConfigSchema } from '@hyperlane-xyz/sdk';

const BacklogMessageSchema = z.object({
  attempts: z.number(),
  lastAttempt: z.number(),
  message: z.string(),
  dispatchTx: z.string(),
});

const MessageBacklogSchema = z.array(BacklogMessageSchema);

type DerivedHookConfig = z.infer<
  z.ZodIntersection<
    z.ZodObject<{ address: z.ZodString }>,
    typeof HookConfigSchema
  >
>;
type DerivedIsmConfig = z.infer<
  z.ZodIntersection<
    z.ZodObject<{ address: z.ZodString }>,
    typeof IsmConfigSchema
  >
>;
type MessageBacklog = z.infer<typeof MessageBacklogSchema>;

export type RelayerCache = {
  hook: Record<string, Record<string, DerivedHookConfig>>;
  ism: Record<string, Record<string, DerivedIsmConfig>>;
  backlog: MessageBacklog;
};

export const RelayerCacheSchema: z.ZodType<RelayerCache> = z.object({
  hook: z.record(
    z.record(z.object({ address: z.string() }).and(HookConfigSchema)),
  ),
  ism: z.record(
    z.record(z.object({ address: z.string() }).and(IsmConfigSchema)),
  ),
  backlog: MessageBacklogSchema,
});

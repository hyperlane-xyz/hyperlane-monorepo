import { z } from 'zod';

import { CallData, HexString } from '@hyperlane-xyz/utils';

import { ZChainName, ZHash, ZNzUint } from '../metadata/customZodTypes.js';

export type TimelockTx = {
  id: HexString;
  delay: number;
  predecessor: HexString;
  salt: HexString;
  data: [CallData, ...CallData[]];
};

export type ExecutableTimelockTx = TimelockTx & {
  encodedExecuteTransaction: HexString;
};

export const TimelockConfigSchema = z.object({
  minimumDelay: ZNzUint,
  proposers: z.array(ZHash).min(1),
  executors: z.array(ZHash).min(1).optional(),
  cancellers: z.array(ZHash).min(1).optional(),
  admin: ZHash.optional(),
});

export const TimelockConfigMapSchema = z.record(
  ZChainName,
  TimelockConfigSchema,
);

export type TimelockConfig = z.infer<typeof TimelockConfigSchema>;
export type TimelockConfigMap = z.infer<typeof TimelockConfigMapSchema>;

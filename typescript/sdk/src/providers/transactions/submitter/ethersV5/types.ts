import { z } from 'zod';

import { ZChainName, ZHash } from '../../../../metadata/customZodTypes.js';

export const EV5GnosisSafeTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
  safeAddress: ZHash,
});

export type EV5GnosisSafeTxSubmitterProps = z.infer<
  typeof EV5GnosisSafeTxSubmitterPropsSchema
>;

export const EV5GnosisSafeTxBuilderPropsSchema = z.object({
  version: z.string().default('1.0'),
  chain: ZChainName,
  safeAddress: ZHash,
});

export type EV5GnosisSafeTxBuilderProps = z.infer<
  typeof EV5GnosisSafeTxBuilderPropsSchema
>;

export const EV5JsonRpcTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
  userAddress: ZHash.optional(),
  privateKey: ZHash.optional(),
});

export type EV5JsonRpcTxSubmitterProps = z.infer<
  typeof EV5JsonRpcTxSubmitterPropsSchema
>;

export const EV5ImpersonatedAccountTxSubmitterPropsSchema =
  EV5JsonRpcTxSubmitterPropsSchema.extend({
    userAddress: ZHash,
  });

export type EV5ImpersonatedAccountTxSubmitterProps = z.infer<
  typeof EV5ImpersonatedAccountTxSubmitterPropsSchema
>;

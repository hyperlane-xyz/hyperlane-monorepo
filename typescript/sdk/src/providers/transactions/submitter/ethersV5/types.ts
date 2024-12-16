import { z } from 'zod';

import { ZChainName, ZHash } from '../../../../metadata/customZodTypes.js';

const ChainSubmitterSchema = z.object({
  chain: ZChainName,
});

export const EV5GnosisSafeTxSubmitterPropsSchema = ChainSubmitterSchema.extend({
  safeAddress: ZHash,
});

export type EV5GnosisSafeTxSubmitterProps = z.infer<
  typeof EV5GnosisSafeTxSubmitterPropsSchema
>;

export const EV5GnosisSafeTxBuilderPropsSchema =
  EV5GnosisSafeTxSubmitterPropsSchema.extend({
    version: z.string().default('1.0'),
  });

export type EV5GnosisSafeTxBuilderProps = z.infer<
  typeof EV5GnosisSafeTxBuilderPropsSchema
>;

export const EV5JsonRpcTxSubmitterPropsSchema = ChainSubmitterSchema.extend({
  userAddress: ZHash.optional(),
  privateKey: ZHash.optional(),
});

export type EV5JsonRpcTxSubmitterProps = z.infer<
  typeof EV5JsonRpcTxSubmitterPropsSchema
>;

export const EV5ImpersonatedAccountTxSubmitterPropsSchema =
  EV5JsonRpcTxSubmitterPropsSchema.required({ userAddress: true });

export type EV5ImpersonatedAccountTxSubmitterProps = z.infer<
  typeof EV5ImpersonatedAccountTxSubmitterPropsSchema
>;

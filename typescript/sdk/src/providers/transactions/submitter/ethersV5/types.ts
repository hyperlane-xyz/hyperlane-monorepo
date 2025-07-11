import { z } from 'zod';

import { ZChainName, ZHash } from '../../../../metadata/customZodTypes.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

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

export const EvmSubmitterMetadataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(TxSubmitterType.JSON_RPC),
    ...EV5JsonRpcTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.IMPERSONATED_ACCOUNT),
    ...EV5ImpersonatedAccountTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.GNOSIS_SAFE),
    ...EV5GnosisSafeTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.GNOSIS_TX_BUILDER),
    ...EV5GnosisSafeTxBuilderPropsSchema.shape,
  }),
]);

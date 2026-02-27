import { z } from 'zod';

import { Address } from '@hyperlane-xyz/utils';

import {
  ZBigIntish,
  ZBytes32String,
  ZChainName,
  ZHash,
} from '../../../../metadata/customZodTypes.js';
import { ChainName } from '../../../../types.js';
import { isCompliant } from '../../../../utils/schemas.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export const EvmGnosisSafeTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
  safeAddress: ZHash,
});

export type EvmGnosisSafeTxSubmitterProps = z.infer<
  typeof EvmGnosisSafeTxSubmitterPropsSchema
>;

export const EvmGnosisSafeTxBuilderPropsSchema = z.object({
  version: z.string().default('1.0'),
  chain: ZChainName,
  safeAddress: ZHash,
});

export type EvmGnosisSafeTxBuilderProps = z.infer<
  typeof EvmGnosisSafeTxBuilderPropsSchema
>;

export const EvmJsonRpcTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
  userAddress: ZHash.optional(),
  privateKey: ZHash.optional(),
  extraParams: z.record(z.string(), z.string()).optional(),
});

export type EvmJsonRpcTxSubmitterProps = z.infer<
  typeof EvmJsonRpcTxSubmitterPropsSchema
>;

export const isJsonRpcSubmitterConfig = isCompliant(
  EvmJsonRpcTxSubmitterPropsSchema,
);

export const EvmImpersonatedAccountTxSubmitterPropsSchema =
  EvmJsonRpcTxSubmitterPropsSchema.extend({
    userAddress: ZHash,
  });

export type EvmImpersonatedAccountTxSubmitterProps = z.infer<
  typeof EvmImpersonatedAccountTxSubmitterPropsSchema
>;

export type EvmIcaTxSubmitterProps = {
  type: TxSubmitterType.INTERCHAIN_ACCOUNT;
  chain: ChainName;
  owner: Address;
  destinationChain: ChainName;
  originInterchainAccountRouter?: Address;
  destinationInterchainAccountRouter?: Address;
  interchainSecurityModule?: Address;
  internalSubmitter: EvmSubmitterMetadata;
};

// @ts-expect-error due to zod3 type inference logic even if the
// EvmGnosisSafeTxBuilderPropsSchema defines the version field with a default value
// it is inferred recursively as an optional field making typescript complain that
// EvmSubmitterMetadataSchema can't be used here.
export const EvmIcaTxSubmitterPropsSchema: z.ZodSchema<EvmIcaTxSubmitterProps> =
  z.lazy(() =>
    z.object({
      type: z.literal(TxSubmitterType.INTERCHAIN_ACCOUNT),
      chain: ZChainName,
      owner: ZHash,
      destinationChain: ZChainName,
      originInterchainAccountRouter: ZHash.optional(),
      destinationInterchainAccountRouter: ZHash.optional(),
      interchainSecurityModule: ZHash.optional(),
      internalSubmitter: EvmSubmitterMetadataSchema,
    }),
  );

export type EvmTimelockControllerSubmitterProps = {
  type: TxSubmitterType.TIMELOCK_CONTROLLER;
  chain: ChainName;
  timelockAddress: Address;
  salt?: string;
  delay?: bigint;
  predecessor?: string;
  proposerSubmitter: EvmSubmitterMetadata;
};

// @ts-expect-error same as the ICA
export const EvmTimelockControllerSubmitterPropsSchema: z.ZodSchema<EvmTimelockControllerSubmitterProps> =
  z.lazy(() =>
    z.object({
      type: z.literal(TxSubmitterType.TIMELOCK_CONTROLLER),
      chain: ZChainName,
      timelockAddress: ZHash,
      salt: ZBytes32String.optional(),
      delay: ZBigIntish.optional(),
      predecessor: ZBytes32String.optional(),
      proposerSubmitter: EvmSubmitterMetadataSchema,
    }),
  );

export const EvmSubmitterMetadataSchema = z.union([
  z.object({
    type: z.literal(TxSubmitterType.JSON_RPC),
    ...EvmJsonRpcTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.IMPERSONATED_ACCOUNT),
    ...EvmImpersonatedAccountTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.GNOSIS_SAFE),
    ...EvmGnosisSafeTxSubmitterPropsSchema.shape,
  }),
  z.object({
    type: z.literal(TxSubmitterType.GNOSIS_TX_BUILDER),
    ...EvmGnosisSafeTxBuilderPropsSchema.shape,
  }),
  EvmIcaTxSubmitterPropsSchema,
  EvmTimelockControllerSubmitterPropsSchema,
]);

export type EvmSubmitterMetadata = z.infer<typeof EvmSubmitterMetadataSchema>;

import { z } from 'zod';

import { Address } from '@hyperlane-xyz/utils';

import {
  ZBigNumberish,
  ZBytes32String,
  ZChainName,
  ZHash,
} from '../../../../metadata/customZodTypes.js';
import { ChainName } from '../../../../types.js';
import { isCompliant } from '../../../../utils/schemas.js';
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
  accountAddress: ZHash.optional(),
  privateKey: ZHash.optional(),
  extraParams: z.record(z.string(), z.string()).optional(),
});

export type EV5JsonRpcTxSubmitterProps = z.infer<
  typeof EV5JsonRpcTxSubmitterPropsSchema
>;

export const isJsonRpcSubmitterConfig = isCompliant(
  EV5JsonRpcTxSubmitterPropsSchema,
);

export const EV5ImpersonatedAccountTxSubmitterPropsSchema =
  EV5JsonRpcTxSubmitterPropsSchema.extend({
    userAddress: ZHash,
  });

export type EV5ImpersonatedAccountTxSubmitterProps = z.infer<
  typeof EV5ImpersonatedAccountTxSubmitterPropsSchema
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

// Builds the ICA submitter schema with a caller-supplied nested submitter schema,
// so the wrapper's field list lives here and is not re-declared by consumers that
// only need to widen the nested submitter (e.g. the CLI allowing its `file`
// submitter as `internalSubmitter`; see cli/src/submitters/types.ts). The nested
// schema is read through a thunk so a union declared later in module load order
// (e.g. EvmSubmitterMetadataSchema) can be referenced without a TDZ error. TOut is
// the resulting parsed type, supplied explicitly by the caller.
export const buildEvmIcaTxSubmitterPropsSchema = <TOut>(
  getInternalSubmitterSchema: () => z.ZodTypeAny,
): z.ZodSchema<TOut> =>
  // @ts-expect-error due to zod3 type inference logic even if the
  // EV5GnosisSafeTxBuilderPropsSchema defines the version field with a default value
  // it is inferred recursively as an optional field making typescript complain that
  // the nested submitter schema can't be used here.
  z.lazy(() =>
    z.object({
      type: z.literal(TxSubmitterType.INTERCHAIN_ACCOUNT),
      chain: ZChainName,
      owner: ZHash,
      destinationChain: ZChainName,
      originInterchainAccountRouter: ZHash.optional(),
      destinationInterchainAccountRouter: ZHash.optional(),
      interchainSecurityModule: ZHash.optional(),
      internalSubmitter: getInternalSubmitterSchema(),
    }),
  );

export const EvmIcaTxSubmitterPropsSchema: z.ZodSchema<EvmIcaTxSubmitterProps> =
  buildEvmIcaTxSubmitterPropsSchema<EvmIcaTxSubmitterProps>(
    () => EvmSubmitterMetadataSchema,
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

export const buildEvmTimelockControllerSubmitterPropsSchema = <TOut>(
  getProposerSubmitterSchema: () => z.ZodTypeAny,
): z.ZodSchema<TOut> =>
  // @ts-expect-error same as the ICA
  z.lazy(() =>
    z.object({
      type: z.literal(TxSubmitterType.TIMELOCK_CONTROLLER),
      chain: ZChainName,
      timelockAddress: ZHash,
      salt: ZBytes32String.optional(),
      delay: ZBigNumberish.optional(),
      predecessor: ZBytes32String.optional(),
      proposerSubmitter: getProposerSubmitterSchema(),
    }),
  );

export const EvmTimelockControllerSubmitterPropsSchema: z.ZodSchema<EvmTimelockControllerSubmitterProps> =
  buildEvmTimelockControllerSubmitterPropsSchema<EvmTimelockControllerSubmitterProps>(
    () => EvmSubmitterMetadataSchema,
  );

export const EvmSubmitterMetadataSchema = z.union([
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
  EvmIcaTxSubmitterPropsSchema,
  EvmTimelockControllerSubmitterPropsSchema,
]);

export type EvmSubmitterMetadata = z.infer<typeof EvmSubmitterMetadataSchema>;

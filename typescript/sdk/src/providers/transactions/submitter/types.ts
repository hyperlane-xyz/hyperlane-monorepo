import { z } from 'zod';

import { ZChainName, ZHash } from '../../../metadata/customZodTypes.js';

import { TxSubmitterType } from './TxSubmitterTypes.js';
import { EvmSubmitterMetadataSchema } from './ethersV5/types.js';

export const EvmIcaTxSubmitterPropsSchema = z.object({
  type: z.literal(TxSubmitterType.INTERCHAIN_ACCOUNT),
  chain: ZChainName,
  owner: ZHash,
  destinationChain: ZChainName,
  originInterchainAccountRouter: ZHash.optional(),
  destinationInterchainAccountRouter: ZHash.optional(),
  interchainSecurityModule: ZHash.optional(),
  internalSubmitter: EvmSubmitterMetadataSchema,
});

export type EvmIcaTxSubmitterProps = z.infer<
  typeof EvmIcaTxSubmitterPropsSchema
>;

export const SubmitterMetadataSchema = z.union([
  EvmSubmitterMetadataSchema,
  EvmIcaTxSubmitterPropsSchema,
]);

export type SubmitterMetadata = z.infer<typeof SubmitterMetadataSchema>;

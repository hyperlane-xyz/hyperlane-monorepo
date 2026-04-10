import { z } from 'zod';

import { EvmSubmitterMetadataSchema } from './ethersV5/types.js';
import { TxSubmitterType } from './TxSubmitterTypes.js';

export const SubmitterMetadataSchema = EvmSubmitterMetadataSchema;
export type SubmitterMetadata = z.infer<typeof EvmSubmitterMetadataSchema>;

export const UnresolvedSubmitterReferenceSchema = z
  .object({
    type: z.literal(TxSubmitterType.SUBMITTER_REF),
    ref: z.string().min(1),
  })
  .strict();

export type UnresolvedSubmitterReference = z.infer<
  typeof UnresolvedSubmitterReferenceSchema
>;

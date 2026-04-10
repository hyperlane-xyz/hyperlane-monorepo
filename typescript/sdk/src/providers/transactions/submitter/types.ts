import { z } from 'zod';

import { EvmSubmitterMetadataSchema } from './ethersV5/types.js';

export const SubmitterMetadataSchema = EvmSubmitterMetadataSchema;
export type SubmitterMetadata = z.infer<typeof EvmSubmitterMetadataSchema>;

export const UnresolvedSubmitterReferenceSchema = z
  .object({
    type: z.literal('submitter_ref'),
    ref: z.string().min(1),
  })
  .strict();

export type UnresolvedSubmitterReference = z.infer<
  typeof UnresolvedSubmitterReferenceSchema
>;

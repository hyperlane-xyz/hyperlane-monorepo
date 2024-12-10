import { z } from 'zod';

import { ZChainName } from '../../../../metadata/customZodTypes.js';
import { SubmitterMetadataSchema } from '../types.js';

export const SubmissionStrategySchema = z
  .object({
    submitter: SubmitterMetadataSchema,
  })
  .strict();

export type SubmissionStrategy = z.infer<typeof SubmissionStrategySchema>;

export const ChainSubmissionStrategySchema = z.record(
  ZChainName,
  SubmissionStrategySchema,
);

export type ChainSubmissionStrategy = z.infer<
  typeof ChainSubmissionStrategySchema
>;

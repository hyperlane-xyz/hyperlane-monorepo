import { z } from 'zod';

import { ZChainName } from '../../../../metadata/customZodTypes.js';
import { SubmitterMetadataSchema } from '../schemas.js';

export const SubmissionStrategySchema = z
  .object({
    submitter: SubmitterMetadataSchema,
  })
  .strict();

export const ChainSubmissionStrategySchema = z.record(
  ZChainName,
  SubmissionStrategySchema,
);

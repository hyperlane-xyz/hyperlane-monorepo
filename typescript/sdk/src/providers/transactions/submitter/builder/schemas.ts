import { z } from 'zod';

import { TransformerMetadataSchema } from '../../transformer/schemas.js';
import { SubmitterMetadataSchema } from '../schemas.js';

export const SubmissionStrategySchema = z.object({
  chain: z.string(),
  submitter: SubmitterMetadataSchema,
  transforms: z.array(TransformerMetadataSchema).optional(),
});

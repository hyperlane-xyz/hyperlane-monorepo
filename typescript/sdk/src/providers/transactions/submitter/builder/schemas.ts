import { z } from 'zod';

import { ZChainName } from '../../../../metadata/customZodTypes.js';
import { TransformerMetadataSchema } from '../../transformer/schemas.js';
import { SubmitterMetadataSchema } from '../schemas.js';

export const SubmissionStrategySchema = z.object({
  chain: ZChainName,
  submitter: SubmitterMetadataSchema,
  transforms: z.array(TransformerMetadataSchema).optional(),
});

import { z } from 'zod';

import {
  ChainSubmissionStrategySchema,
  SubmissionStrategySchema,
} from './schemas.js';

export type SubmissionStrategy = z.infer<typeof SubmissionStrategySchema>;
export type ChainSubmissionStrategy = z.infer<
  typeof ChainSubmissionStrategySchema
>;

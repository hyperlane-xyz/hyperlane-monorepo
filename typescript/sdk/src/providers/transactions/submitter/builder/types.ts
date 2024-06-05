import { z } from 'zod';

import { SubmissionStrategySchema } from './schemas.js';

export type SubmissionStrategy = z.infer<typeof SubmissionStrategySchema>;

import { z } from 'zod';

import type {
  MultiProvider,
  SubmissionStrategySchema,
} from '@hyperlane-xyz/sdk';

export type SubmitterBuilderSettings = {
  submissionStrategy: z.infer<typeof SubmissionStrategySchema>;
  multiProvider: MultiProvider;
};

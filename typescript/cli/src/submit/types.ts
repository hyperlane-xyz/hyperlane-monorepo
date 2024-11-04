import type { MultiProvider, SubmissionStrategy } from '@hyperlane-xyz/sdk';

export type SubmitterBuilderSettings = {
  submissionStrategy: SubmissionStrategy;
  multiProvider: MultiProvider;
};

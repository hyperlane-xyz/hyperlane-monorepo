import { IRegistry } from '@hyperlane-xyz/registry';
import type { MultiProvider, SubmissionStrategy } from '@hyperlane-xyz/sdk';

export type SubmitterBuilderSettings = {
  submissionStrategy: SubmissionStrategy;
  multiProvider: MultiProvider;
  registry: IRegistry;
};

import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { SubmitterContext } from '../submitter/SubmitterContext.js';

export interface ChainHandler {
  /**
   * Determines the chains to be used for signing
   * @param argv Command arguments
   * @returns Array of chain names
   */
  determineChains(argv: Record<string, any>): Promise<ChainName[]>;

  /**
   * Creates a context manager for the selected chains
   * @param chains Selected chains
   * @param strategyConfig Default strategy configuration
   * @returns SubmitterContext instance
   */
  createSubmitterContext(
    chains: ChainName[],
    strategyConfig: ChainSubmissionStrategy,
    argv?: Record<string, any>,
  ): SubmitterContext;

  /**
   * Configures signers for the multi-provider
   * @param argv Command arguments
   * @param multiProvider MultiProvider instance
   * @param submitterContext SubmitterContext instance
   */
  configureSigners(
    argv: Record<string, any>,
    multiProvider: MultiProvider,
    submitterContext: SubmitterContext,
  ): Promise<void>;
}

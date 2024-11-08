import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { ContextManager } from '../../manager/ContextManager.js';

export interface WarpDeployContextResult {
  warpRouteConfig: Record<ChainName, any>;
  chains: ChainName[];
}

export interface SignerStrategy {
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
   * @returns ContextManager instance
   */
  createContextManager(
    chains: ChainName[],
    strategyConfig: ChainSubmissionStrategy,
    argv?: any,
  ): ContextManager;

  /**
   * Configures signers for the multi-provider
   * @param argv Command arguments
   * @param multiProvider MultiProvider instance
   * @param contextManager ContextManager instance
   */
  configureSigners(
    argv: Record<string, any>,
    multiProvider: MultiProvider,
    contextManager: ContextManager,
  ): Promise<void>;
}

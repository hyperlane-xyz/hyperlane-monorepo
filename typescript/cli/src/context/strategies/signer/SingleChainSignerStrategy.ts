import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { runSingleChainSelectionStep } from '../../../utils/chains.js';
import { SubmitterContext } from '../submitter/SubmitterContext.js';

import { SignerStrategy } from './SignerStrategy.js';

/**
 * @title SingleChainSignerStrategy
 * @notice Strategy implementation for managing single-chain operations
 * @dev This strategy is used by commands that operate on a single blockchain
 *      It implements the SignerStrategy interface and is primarily used for
 *      operations like 'core:apply' and 'warp:read' (see SignerStrategyFactory)
 */
export class SingleChainSignerStrategy implements SignerStrategy {
  /**
   * @notice Determines the chain to be used for signing operations
   * @dev Either uses the chain specified in argv or prompts for interactive selection
   */
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const chain: ChainName =
      argv.chain ||
      (await runSingleChainSelectionStep(
        argv.context.chainMetadata,
        'Select chain to connect:',
      ));

    argv.chain = chain;
    return [chain]; // Explicitly return as single-item array
  }

  /**
   * @dev Hardcoded: JSON_RPC as the transaction submitter type
   */
  createSubmitterContext(
    chains: ChainName[],
    strategyConfig: ChainSubmissionStrategy,
    argv?: Record<string, any>,
  ): SubmitterContext {
    return new SubmitterContext(
      strategyConfig,
      chains,
      TxSubmitterType.JSON_RPC,
      argv,
    );
  }

  /**
   * @notice Sets up signers for the specified chain in the MultiProvider
   * @dev Sets up signers for single chain
   */
  async configureSigners(
    argv: Record<string, any>,
    multiProvider: MultiProvider,
    submitterContext: SubmitterContext,
  ): Promise<void> {
    const signers = await submitterContext.getSigners();
    multiProvider.setSigners(signers);
    argv.context.multiProvider = multiProvider;
    argv.submitterContext = submitterContext;
  }
}

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
 * @title OriginDestinationSignerStrategy
 * @notice Strategy implementation for managing multiVM operations requiring both origin and destination chains
 * @dev This strategy is used by the SignerStrategyFactory for sending messages and tokens across chains
 */
export class OriginDestinationSignerStrategy implements SignerStrategy {
  /**
   * @notice Determines and validates the origin and destination chains
   * @dev If origin or destination are not provided in argv, prompts user for interactive selection
   */
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const { context } = argv;

    let origin =
      argv.origin ??
      (await runSingleChainSelectionStep(
        context.chainMetadata,
        'Select the origin chain',
      ));

    let destination =
      argv.destination ??
      (await runSingleChainSelectionStep(
        context.chainMetadata,
        'Select the destination chain',
      ));

    argv.origin = origin;
    argv.destination = destination;
    return [origin, destination]; // Explicitly return as single-item array
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
   * @notice Configures signers for both origin and destination chains
   * @dev Sets up signers in the MultiProvider and updates the context with necessary references
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

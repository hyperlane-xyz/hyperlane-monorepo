import { ChainName } from '@hyperlane-xyz/sdk';

import { runSingleChainSelectionStep } from '../../../utils/chains.js';

import { ChainHandler } from './types.js';

/**
 * @title SingleChainHandler
 * @notice Strategy implementation for managing single-chain operations
 * @dev This strategy is used by commands that operate on a single blockchain
 *      It implements the ChainHandler interface and is primarily used for
 *      operations like 'core:apply' and 'warp:read'
 */
export class SingleChainHandler implements ChainHandler {
  /**
   * @notice Determines the chain to be used for signing operations
   * @dev Either uses the chain specified in argv or prompts for interactive selection
   */
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    argv.chain =
      argv.chain ||
      (await runSingleChainSelectionStep(
        argv.context.chainMetadata,
        'Select chain to connect:',
      ));

    return [argv.chain]; // Explicitly return as single-item array
  }
}

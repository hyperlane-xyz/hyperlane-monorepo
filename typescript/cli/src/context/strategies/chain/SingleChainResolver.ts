import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import { runSingleChainSelectionStep } from '../../../utils/chains.js';

import { ChainResolver } from './types.js';

/**
 * @title SingleChainResolver
 * @notice Strategy implementation for managing single-chain operations
 * @dev Primarily used for operations like 'core:apply' and 'warp:read'
 */
export class SingleChainResolver implements ChainResolver {
  /**
   * @notice Determines the chain to be used for signing operations
   * @dev Either uses the chain specified in argv or prompts for interactive selection
   */
  async resolveChains(argv: ChainMap<any>): Promise<ChainName[]> {
    argv.chain ||= await runSingleChainSelectionStep(
      argv.context.chainMetadata,
      'Select chain to connect:',
    );

    return [argv.chain]; // Explicitly return as single-item array
  }
}

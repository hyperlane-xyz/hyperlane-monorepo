import { ChainName } from '@hyperlane-xyz/sdk';

export interface ChainHandler {
  /**
   * Determines the chains to be used for signing
   * @param argv Command arguments
   * @returns Array of chain names
   */
  resolveChains(argv: Record<string, any>): Promise<ChainName[]>;
}

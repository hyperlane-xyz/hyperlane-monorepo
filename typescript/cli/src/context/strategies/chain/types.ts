import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

export interface ChainResolver {
  /**
   * Determines the chains to be used for signing
   * @param argv Command arguments
   * @returns Array of chain names
   */
  resolveChains(argv: ChainMap<any>): Promise<ChainName[]>;
}

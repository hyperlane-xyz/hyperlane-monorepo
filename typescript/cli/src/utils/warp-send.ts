import { type ChainName, type MultiProvider } from '@hyperlane-xyz/sdk';
import { isEVMLike } from '@hyperlane-xyz/utils';

/**
 * Orders warp send path defaults consistently:
 * EVM-like chains first (alphabetical), then non-EVM (alphabetical).
 */
export function getOrderedWarpSendChains(
  chains: Iterable<ChainName>,
  multiProvider: MultiProvider,
): ChainName[] {
  const uniqueChains = [...new Set(chains)];
  const evmChains = uniqueChains
    .filter((chain) => isEVMLike(multiProvider.getProtocol(chain)))
    .sort((a, b) => a.localeCompare(b));
  const nonEvmChains = uniqueChains
    .filter((chain) => !isEVMLike(multiProvider.getProtocol(chain)))
    .sort((a, b) => a.localeCompare(b));

  return [...evmChains, ...nonEvmChains];
}

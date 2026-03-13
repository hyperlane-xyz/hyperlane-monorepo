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
  return [...new Set(chains)].sort((a, b) => {
    const aEvm = isEVMLike(multiProvider.getProtocol(a)) ? 0 : 1;
    const bEvm = isEVMLike(multiProvider.getProtocol(b)) ? 0 : 1;
    return aEvm - bEvm || a.localeCompare(b);
  });
}

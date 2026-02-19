import { type ChainName, type MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

/**
 * Orders warp send path defaults consistently:
 * EVM chains first (alphabetical), then non-EVM (alphabetical).
 */
export function getOrderedWarpSendChains(
  chains: Iterable<ChainName>,
  multiProvider: MultiProvider,
): ChainName[] {
  const uniqueChains = [...new Set(chains)];
  const evmChains = uniqueChains
    .filter(
      (chain) => multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
    )
    .sort((a, b) => a.localeCompare(b));
  const nonEvmChains = uniqueChains
    .filter(
      (chain) => multiProvider.getProtocol(chain) !== ProtocolType.Ethereum,
    )
    .sort((a, b) => a.localeCompare(b));

  return [...evmChains, ...nonEvmChains];
}

import { CCIP_NETWORKS } from '../consts/ccip.js';

/**
 * Gets the chain name from a CCIP chain selector value
 * @param chainSelector The CCIP chain selector value
 * @returns The chain name if found, undefined otherwise
 */
export function getChainNameFromCCIPSelector(
  chainSelector: string,
): string | undefined {
  for (const [chainName, networkInfo] of Object.entries(CCIP_NETWORKS)) {
    if (networkInfo.chainSelector === chainSelector) {
      return chainName;
    }
  }
  return undefined;
}

/**
 * Gets the CCIP chain selector value for a given chain name
 * @param chainName The name of the chain
 * @returns The CCIP chain selector if found, undefined otherwise
 */
export function getCCIPChainSelector(chainName: string): string | undefined {
  return CCIP_NETWORKS[chainName]?.chainSelector;
}

/**
 * Gets the CCIP router address for a given chain name
 * @param chainName The name of the chain
 * @returns The CCIP router address if found, undefined otherwise
 */
export function getCCIPRouterAddress(chainName: string): string | undefined {
  return CCIP_NETWORKS[chainName]?.router?.address;
}

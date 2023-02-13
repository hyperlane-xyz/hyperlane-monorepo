import { chainMetadata } from './consts/chainMetadata';
import { AllChains } from './consts/chains';
import { ChainMap, ChainName } from './types';

/**
 * @deprecated Prefer using methods in MultiProvider for PI support
 */
export const DomainIdToChainName = Object.fromEntries(
  AllChains.map((chain) => {
    if (!chainMetadata[chain])
      throw new Error(`Chain metadata for ${chain} could not be found`);
    return [chainMetadata[chain].chainId, chain];
  }),
) as Record<number, ChainName>;

/**
 * @deprecated Prefer using methods in MultiProvider for PI support
 */
export const ChainNameToDomainId = Object.fromEntries(
  AllChains.map((chain) => [chain, chainMetadata[chain].chainId]),
) as ChainMap<number>;

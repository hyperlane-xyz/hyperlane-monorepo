import { chainMetadata } from './consts/chainMetadata';
import { AllChains } from './consts/chains';
import { ChainName, CompleteChainMap } from './types';

export const DomainIdToChainName = Object.fromEntries(
  AllChains.map((chain) => [chainMetadata[chain].id, chain]),
) as Record<number, ChainName>;

export const ChainNameToDomainId = Object.fromEntries(
  AllChains.map((chain) => [chain, chainMetadata[chain].id]),
) as CompleteChainMap<number>;

import { ChainName } from '../types';

/**
 * Enumeration of Hyperlane supported chains
 */
export enum Chains { // must be string type to be used with Object.keys
  arbitrum = 'arbitrum',
  alfajores = 'alfajores',
  bsc = 'bsc',
  mumbai = 'mumbai',
  kovan = 'kovan',
  goerli = 'goerli',
  fuji = 'fuji',
  celo = 'celo',
  ethereum = 'ethereum',
  avalanche = 'avalanche',
  optimism = 'optimism',
  polygon = 'polygon',
  bsctestnet = 'bsctestnet',
  arbitrumrinkeby = 'arbitrumrinkeby',
  optimismkovan = 'optimismkovan',
  auroratestnet = 'auroratestnet',
  test1 = 'test1',
  test2 = 'test2',
  test3 = 'test3',
}

export const Mainnets = [
  Chains.arbitrum,
  Chains.avalanche,
  Chains.bsc,
  Chains.celo,
  Chains.ethereum,
  Chains.optimism,
  Chains.polygon,
] as Array<ChainName>;

export const AllChains = Object.keys(Chains) as Array<ChainName>;

/**
 * Enumeration of Hyperlane supported chains
 * Must be string type to be used with Object.keys
 */
export enum Chains {
  alfajores = 'alfajores',
  arbitrum = 'arbitrum',
  arbitrumgoerli = 'arbitrumgoerli',
  avalanche = 'avalanche',
  bsc = 'bsc',
  bsctestnet = 'bsctestnet',
  celo = 'celo',
  ethereum = 'ethereum',
  fuji = 'fuji',
  goerli = 'goerli',
  moonbasealpha = 'moonbasealpha',
  moonbeam = 'moonbeam',
  mumbai = 'mumbai',
  optimism = 'optimism',
  optimismgoerli = 'optimismgoerli',
  polygon = 'polygon',
  gnosis = 'gnosis',
  test1 = 'test1',
  test2 = 'test2',
  test3 = 'test3',
}

export type CoreChainName = keyof typeof Chains;

export enum DeprecatedChains {
  arbitrumkovan = 'arbitrumkovan',
  arbitrumrinkeby = 'arbitrumrinkeby',
  kovan = 'kovan',
  rinkeby = 'rinkeby',
  optimismkovan = 'optimismkovan',
  optimismrinkeby = 'optimismrinkeby',
}

export const AllDeprecatedChains = Object.keys(DeprecatedChains) as string[];

export const Mainnets: Array<CoreChainName> = [
  Chains.arbitrum,
  Chains.avalanche,
  Chains.bsc,
  Chains.celo,
  Chains.ethereum,
  Chains.moonbeam,
  Chains.optimism,
  Chains.polygon,
  Chains.gnosis,
];

export const Testnets: Array<CoreChainName> = [
  Chains.alfajores,
  Chains.arbitrumgoerli,
  Chains.bsctestnet,
  Chains.fuji,
  Chains.goerli,
  Chains.moonbasealpha,
  Chains.mumbai,
  Chains.optimismgoerli,
];

export const TestChains: Array<CoreChainName> = [
  Chains.test1,
  Chains.test2,
  Chains.test3,
];

export const AllChains: Array<CoreChainName> = [
  ...Mainnets,
  ...TestChains,
  ...TestChains,
];

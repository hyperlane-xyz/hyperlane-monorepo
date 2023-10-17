/**
 * Enumeration of Hyperlane supported chains
 * Must be string type to be used with Object.keys
 */
export enum Chains {
  alfajores = 'alfajores',
  arbitrum = 'arbitrum',
  arbitrumgoerli = 'arbitrumgoerli',
  avalanche = 'avalanche',
  basegoerli = 'basegoerli',
  bsc = 'bsc',
  bsctestnet = 'bsctestnet',
  celo = 'celo',
  chiado = 'chiado',
  ethereum = 'ethereum',
  fuji = 'fuji',
  gnosis = 'gnosis',
  goerli = 'goerli',
  lineagoerli = 'lineagoerli',
  scrollsepolia = 'scrollsepolia',
  sepolia = 'sepolia',
  moonbasealpha = 'moonbasealpha',
  moonbeam = 'moonbeam',
  mumbai = 'mumbai',
  nautilus = 'nautilus',
  optimism = 'optimism',
  optimismgoerli = 'optimismgoerli',
  polygon = 'polygon',
  polygonzkevmtestnet = 'polygonzkevmtestnet',
  proteustestnet = 'proteustestnet',
  solana = 'solana',
  solanadevnet = 'solanadevnet',
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
  Chains.solana,
];

export const Testnets: Array<CoreChainName> = [
  Chains.alfajores,
  Chains.arbitrumgoerli,
  Chains.basegoerli,
  Chains.bsctestnet,
  Chains.chiado,
  Chains.fuji,
  Chains.lineagoerli,
  Chains.goerli,
  Chains.moonbasealpha,
  Chains.mumbai,
  Chains.optimismgoerli,
  Chains.polygonzkevmtestnet,
  Chains.scrollsepolia,
  Chains.sepolia,
  Chains.solanadevnet,
];

export const TestChains: Array<CoreChainName> = [
  Chains.test1,
  Chains.test2,
  Chains.test3,
];

export const AllChains: Array<CoreChainName> = [
  ...Mainnets,
  ...Testnets,
  ...TestChains,
];

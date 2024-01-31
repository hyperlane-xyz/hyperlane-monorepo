/**
 * Enumeration of Hyperlane supported chains
 * Must be string type to be used with Object.keys
 */
export enum Chains {
  alfajores = 'alfajores',
  arbitrum = 'arbitrum',
  arbitrumgoerli = 'arbitrumgoerli',
  avalanche = 'avalanche',
  base = 'base',
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
  mantapacific = 'mantapacific',
  moonbasealpha = 'moonbasealpha',
  moonbeam = 'moonbeam',
  mumbai = 'mumbai',
  nautilus = 'nautilus',
  neutron = 'neutron',
  optimism = 'optimism',
  optimismgoerli = 'optimismgoerli',
  polygon = 'polygon',
  polygonzkevm = 'polygonzkevm',
  polygonzkevmtestnet = 'polygonzkevmtestnet',
  proteustestnet = 'proteustestnet',
  scroll = 'scroll',
  scrollsepolia = 'scrollsepolia',
  sepolia = 'sepolia',
  solana = 'solana',
  solanadevnet = 'solanadevnet',
  solanatestnet = 'solanatestnet',
  eclipsetestnet = 'eclipsetestnet',
  viction = 'viction',
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
  Chains.neutron,
  Chains.mantapacific,
  Chains.moonbeam,
  Chains.optimism,
  Chains.polygon,
  Chains.gnosis,
  Chains.base,
  Chains.scroll,
  Chains.polygonzkevm,
  Chains.viction,
  // Chains.solana,
];

export const Testnets: Array<CoreChainName> = [
  Chains.alfajores,
  Chains.arbitrumgoerli,
  Chains.basegoerli,
  Chains.bsctestnet,
  Chains.chiado,
  Chains.fuji,
  Chains.goerli,
  Chains.lineagoerli,
  Chains.moonbasealpha,
  Chains.mumbai,
  Chains.optimismgoerli,
  Chains.polygonzkevmtestnet,
  Chains.scrollsepolia,
  Chains.sepolia,
  Chains.solanadevnet,
  Chains.solanatestnet,
  Chains.eclipsetestnet,
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

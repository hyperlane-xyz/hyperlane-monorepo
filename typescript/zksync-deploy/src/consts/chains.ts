export enum ProtocolType {
  Ethereum = 'ethereum',
}

/**
 * Enumeration of Hyperlane supported chains
 * Must be string type to be used with Object.keys
 */
export enum Chains {
  zksyncera = 'zksyncera',
  zksyncerasepolia = 'zksyncerasepolia',
  test1 = 'test1',
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

export const TestChains: Array<CoreChainName> = [Chains.test1];

export const AllDeprecatedChains = Object.keys(DeprecatedChains) as string[];

export const Mainnets: Array<CoreChainName> = [Chains.zksyncera];

export const Testnets: Array<CoreChainName> = [Chains.zksyncerasepolia];

export const AllChains: Array<CoreChainName> = [
  ...Mainnets,
  ...Testnets,
  ...TestChains,
];

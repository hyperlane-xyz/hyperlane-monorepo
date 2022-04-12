import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';

/**
 * RPC Pagination information for Polygon
 */
export interface Pagination {
  blocks: number;
  from: number;
}

/**
 * The names of Abacus supported chains
 */
const ALL_MAINNET_NAMES = ['celo', 'ethereum', 'avalanche', 'polygon'] as const;
type MainnetNamesTuple = typeof ALL_MAINNET_NAMES;
type MainnetChainNames = MainnetNamesTuple[number];

const ALL_TESTNET_NAMES = [
  'alfajores',
  'mumbai',
  'kovan',
  'goerli',
  'fuji',
  'rinkarby',
  'rinkeby',
  'ropsten',
] as const;
type TestnetNamesTuple = typeof ALL_TESTNET_NAMES;
type TestnetChainNames = TestnetNamesTuple[number];

const ALL_TEST_NAMES = ['test1', 'test2', 'test3'] as const;
type TestNamesTuple = typeof ALL_TEST_NAMES;
type TestChainNames = TestNamesTuple[number];

export const ALL_CHAIN_NAMES = [
  ...ALL_MAINNET_NAMES,
  ...ALL_TESTNET_NAMES,
  ...ALL_TEST_NAMES,
];
export type ChainName = MainnetChainNames | TestnetChainNames | TestChainNames;

/**
 * A Domain (and its characteristics)
 */
export interface Domain {
  id: number;
  name: ChainName;
  nativeTokenDecimals?: number;
  paginate?: Pagination;
}

export type Connection = ethers.providers.Provider | ethers.Signer;

export type ProxiedAddress = {
  proxy: types.Address;
  implementation: types.Address;
  beacon: types.Address;
};

export type NameOrDomain = ChainName | number;

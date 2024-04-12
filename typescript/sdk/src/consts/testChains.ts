import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName } from '../types.js';

export enum TestChainName {
  test1 = 'test1',
  test2 = 'test2',
  test3 = 'test3',
}

export const testChains: Array<ChainName> = Object.values(TestChainName);

export const test1: ChainMetadata = {
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 0,
  },
  chainId: 13371,
  displayName: 'Test 1',
  domainId: 13371,
  isTestnet: true,
  name: 'test1',
  nativeToken: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
};

export const test2: ChainMetadata = {
  ...test1,
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 1,
  },
  chainId: 13372,
  displayName: 'Test 2',
  domainId: 13372,
  name: 'test2',
};

export const test3: ChainMetadata = {
  ...test1,
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 2,
  },
  chainId: 13373,
  displayName: 'Test 3',
  domainId: 13373,
  name: 'test3',
};

export const testChainMetadata: ChainMap<ChainMetadata> = {
  test1,
  test2,
  test3,
};

export const testCosmosChain: ChainMetadata = {
  bech32Prefix: 'testcosmos',
  chainId: 'testcosmos',
  domainId: 123456789,
  grpcUrls: [],
  name: 'testcosmos',
  nativeToken: { decimals: 6, denom: 'uatom', name: 'Atom', symbol: 'ATOM' },
  protocol: ProtocolType.Cosmos,
  restUrls: [],
  rpcUrls: [{ http: 'http://127.0.0.1:1317' }],
  slip44: 118,
};

export const testSealevelChain: ChainMetadata = {
  chainId: 987654321,
  domainId: 987654321,
  name: 'testsealevel',
  protocol: ProtocolType.Sealevel,
  rpcUrls: [{ http: 'http://127.0.0.1:8899' }],
};

export const multiProtocolTestChainMetadata: ChainMap<ChainMetadata> = {
  ...testChainMetadata,
  testcosmos: testCosmosChain,
  testsealevel: testSealevelChain,
};

export const multiProtocolTestChains: Array<ChainName> = Object.keys(
  multiProtocolTestChainMetadata,
);

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ChainMetadata,
  ExplorerFamily,
} from '../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName } from '../types.js';

export enum TestChainName {
  test1 = 'test1',
  test2 = 'test2',
  test3 = 'test3',
  test4 = 'test4',
}

export const testChains: Array<ChainName> = Object.values(TestChainName);

export const test1: ChainMetadata = {
  blockExplorers: [
    {
      apiKey: 'fakekey',
      apiUrl: 'https://api.etherscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'Etherscan',
      url: 'https://etherscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 0,
  },
  chainId: 9913371,
  displayName: 'Test 1',
  domainId: 9913371,
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
  chainId: 9913372,
  displayName: 'Test 2',
  domainId: 9913372,
  name: 'test2',
};

export const test3: ChainMetadata = {
  ...test1,
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 2,
  },
  chainId: 9913373,
  displayName: 'Test 3',
  domainId: 9913373,
  name: 'test3',
};

export const test4: ChainMetadata = {
  ...test1,
  chainId: 31337,
  displayName: 'Test 4',
  domainId: 31337,
  name: 'test4',
};

export const testXERC20: ChainMetadata = {
  ...test1,
  chainId: 9913374,
  domainId: 9913374,
  displayName: 'Test XERC20',
  name: 'testxerc20',
};

export const testVSXERC20: ChainMetadata = {
  ...test1,
  chainId: 9913375,
  domainId: 9913375,
  displayName: 'Test VSXERC20',
  name: 'testvsxerc20',
};

export const testXERC20Lockbox: ChainMetadata = {
  ...test1,
  chainId: 9913376,
  domainId: 9913376,
  displayName: 'Test XERC20Lockbox',
  name: 'testxerc20lockbox',
};

export const testChainMetadata: ChainMap<ChainMetadata> = {
  test1,
  test2,
  test3,
  test4,
};

export const testCosmosChain: ChainMetadata = {
  bech32Prefix: 'testcosmos',
  blockExplorers: [
    {
      apiUrl: 'https://www.mintscan.io/cosmos',
      family: ExplorerFamily.Other,
      name: 'Mintscan',
      url: 'https://www.mintscan.io/cosmos',
    },
  ],
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
  blockExplorers: [
    {
      apiUrl: 'https://explorer.solana.com?cluster=devnet',
      family: ExplorerFamily.Other,
      name: 'Solana Explorer',
      url: 'https://explorer.solana.com?cluster=devnet',
    },
  ],
  chainId: 987654321,
  domainId: 987654321,
  name: 'testsealevel',
  nativeToken: { decimals: 9, name: 'Sol', symbol: 'SOL' },
  protocol: ProtocolType.Sealevel,
  rpcUrls: [{ http: 'http://127.0.0.1:8899' }],
};

export const testStarknetChain: ChainMetadata = {
  chainId: '0x534e5f5345504f4c4941',
  domainId: 5854809,
  name: 'starknetdevnet',
  nativeToken: {
    decimals: 18,
    denom: '0x49D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7',
    name: 'Ether',
    symbol: 'ETH',
  },
  protocol: ProtocolType.Starknet,
  rpcUrls: [
    {
      http: 'http://127.0.0.1:5050',
    },
  ],
};

export const multiProtocolTestChainMetadata: ChainMap<ChainMetadata> = {
  ...testChainMetadata,
  testcosmos: testCosmosChain,
  testsealevel: testSealevelChain,
  testxerc20: testXERC20,
  testvsxerc20: testVSXERC20,
  testxerc20lockbox: testXERC20Lockbox,
  starknetdevnet: testStarknetChain,
};

export const multiProtocolTestChains: Array<ChainName> = Object.keys(
  multiProtocolTestChainMetadata,
);

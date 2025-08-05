import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ChainMetadata,
  ChainTechnicalStack,
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

export const testScale1: ChainMetadata = {
  ...test1,
  chainId: 9913377,
  domainId: 9913377,
  displayName: 'Test Scale 1',
  name: 'testscale1',
};

export const testScale2: ChainMetadata = {
  ...test1,
  chainId: 9913378,
  domainId: 9913378,
  displayName: 'Test Scale 2',
  name: 'testscale2',
};

export const testCollateralFiat: ChainMetadata = {
  ...test1,
  chainId: 9913379,
  domainId: 9913379,
  displayName: 'Test Collateral Fiat',
  name: 'testcollateralfiat',
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
  blockExplorers: [
    {
      apiUrl: 'https://sepolia.voyager.online/api',
      family: ExplorerFamily.Voyager,
      name: 'Starknet Sepolia Explorer',
      url: 'https://sepolia.voyager.online',
    },
  ],
};

// Address of a timelock contract on base that can be used for integration tests
export const KNOWN_BASE_TIMELOCK_CONTRACT =
  '0x733BC1F0D76AB8f0AB7C1c8044ECc4720Cd402AD';

// Base chain metadata for testing with block explorer
export const baseTestChain: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://base.blockscout.com/api',
      family: ExplorerFamily.Blockscout,
      name: 'Base Explorer',
      url: 'https://base.blockscout.com',
    },
  ],
  blocks: { confirmations: 3, estimateBlockTime: 2, reorgPeriod: 10 },
  chainId: 8453,
  displayName: 'Base',
  domainId: 8453,
  gasCurrencyCoinGeckoId: 'ethereum',
  name: 'base',
  nativeToken: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  protocol: ProtocolType.Ethereum,
  rpcUrls: [
    { http: 'https://base.publicnode.com' },
    { http: 'https://mainnet.base.org' },
    { http: 'https://base.blockpi.network/v1/rpc/public' },
    { http: 'https://base.drpc.org' },
    { http: 'https://base.llamarpc.com' },
    { http: 'https://1rpc.io/base' },
    { http: 'https://base-pokt.nodies.app' },
  ],
  technicalStack: ChainTechnicalStack.OpStack,
};

export const multiProtocolTestChainMetadata: ChainMap<ChainMetadata> = {
  ...testChainMetadata,
  testcosmos: testCosmosChain,
  testsealevel: testSealevelChain,
  testxerc20: testXERC20,
  testvsxerc20: testVSXERC20,
  testxerc20lockbox: testXERC20Lockbox,
  starknetdevnet: testStarknetChain,
  testscale1: testScale1,
  testscale2: testScale2,
  testcollateralfiat: testCollateralFiat,
};

export const multiProtocolTestChains: Array<ChainName> = Object.keys(
  multiProtocolTestChainMetadata,
);

import { type PopulatedTransaction, ethers, type providers } from 'ethers';
import Sinon from 'sinon';

import {
  type ChainMap,
  type ChainMetadata,
  type ChainName,
  EvmMovableCollateralAdapter,
  type InterchainGasQuote,
  type MultiProvider,
  type Token,
  type TokenAmount,
  type WarpCore,
} from '@hyperlane-xyz/sdk';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import { RebalancerStrategyOptions } from '../config/types.js';
import type {
  IRebalancer,
  PreparedTransaction,
  RebalanceExecutionResult,
  RebalanceRoute,
} from '../interfaces/IRebalancer.js';
import type { StrategyRoute } from '../interfaces/IStrategy.js';
import type { BridgeConfigWithOverride } from '../utils/index.js';

// === Mock Classes ===

export class MockRebalancer implements IRebalancer {
  rebalance(_routes: RebalanceRoute[]): Promise<RebalanceExecutionResult[]> {
    return Promise.resolve([]);
  }
}

// === Test Data Builders ===

export function buildTestRoute(
  overrides: Partial<StrategyRoute> = {},
): StrategyRoute {
  return {
    origin: 'ethereum',
    destination: 'arbitrum',
    amount: ethers.utils.parseEther('100').toBigInt(),
    bridge: TEST_ADDRESSES.bridge,
    ...overrides,
  };
}

export function buildTestRebalanceRoute(
  overrides: Partial<RebalanceRoute> = {},
): RebalanceRoute {
  return {
    intentId: overrides.intentId ?? `test-route-${Date.now()}`,
    origin: 'ethereum',
    destination: 'arbitrum',
    amount: ethers.utils.parseEther('100').toBigInt(),
    bridge: TEST_ADDRESSES.bridge,
    ...overrides,
  };
}

export function buildTestResult(
  overrides: Partial<RebalanceExecutionResult> = {},
): RebalanceExecutionResult {
  const route = overrides.route ?? buildTestRebalanceRoute();
  return {
    route,
    success: true,
    messageId:
      '0x1111111111111111111111111111111111111111111111111111111111111111',
    txHash:
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    ...overrides,
  };
}

export function buildTestPreparedTransaction(
  overrides: Partial<PreparedTransaction> = {},
): PreparedTransaction {
  const route = overrides.route ?? buildTestRebalanceRoute();
  return {
    populatedTx: {
      to: TEST_ADDRESSES.token,
      data: '0x',
      value: ethers.BigNumber.from(0),
    } as PopulatedTransaction,
    route,
    originTokenAmount: createMockTokenAmount(route.amount),
    ...overrides,
  };
}

// === Mock Factories ===

export function createMockTokenAmount(amount: bigint): TokenAmount {
  return {
    amount,
    token: {
      name: 'TestToken',
      symbol: 'TEST',
      decimals: 18,
      addressOrDenom: TEST_ADDRESSES.token,
    },
    getDecimalFormattedAmount: () => ethers.utils.formatEther(amount),
  } as unknown as TokenAmount;
}

export interface MockAdapterConfig {
  isRebalancer?: boolean;
  allowedDestination?: string;
  isBridgeAllowed?: boolean;
  quotes?: InterchainGasQuote[];
  populatedTx?: PopulatedTransaction;
  throwOnQuotes?: Error;
  throwOnPopulate?: Error;
}

export function createMockAdapter(config: MockAdapterConfig = {}) {
  const {
    isRebalancer = true,
    allowedDestination = TEST_ADDRESSES.arbitrum,
    isBridgeAllowed = true,
    quotes = [{ igpQuote: { amount: BigInt(1000000) } }],
    populatedTx = {
      to: TEST_ADDRESSES.token,
      data: '0x',
      value: ethers.BigNumber.from(0),
    },
    throwOnQuotes,
    throwOnPopulate,
  } = config;

  const adapter = {
    isRebalancer: Sinon.stub().resolves(isRebalancer),
    getAllowedDestination: Sinon.stub().resolves(allowedDestination),
    isBridgeAllowed: Sinon.stub().resolves(isBridgeAllowed),
    getRebalanceQuotes: throwOnQuotes
      ? Sinon.stub().rejects(throwOnQuotes)
      : Sinon.stub().resolves(quotes),
    populateRebalanceTx: throwOnPopulate
      ? Sinon.stub().rejects(throwOnPopulate)
      : Sinon.stub().resolves(populatedTx),
  };

  Object.setPrototypeOf(adapter, EvmMovableCollateralAdapter.prototype);
  return adapter;
}

export interface MockTokenConfig {
  name?: string;
  decimals?: number;
  addressOrDenom?: string;
  adapter?: ReturnType<typeof createMockAdapter>;
}

export function createMockToken(config: MockTokenConfig = {}) {
  const {
    name = 'TestToken',
    decimals = 18,
    addressOrDenom = TEST_ADDRESSES.token,
    adapter = createMockAdapter(),
  } = config;

  const token = {
    name,
    decimals,
    addressOrDenom,
    amount: (amt: bigint) => createMockTokenAmount(amt),
    getHypAdapter: Sinon.stub().returns(adapter),
  };

  return { token, adapter };
}

export interface MockMultiProviderConfig {
  chainMetadata?: ChainMap<Partial<ChainMetadata>>;
  signerAddress?: string;
  sendTransactionReceipt?: providers.TransactionReceipt;
  throwOnSendTransaction?: Error;
  throwOnEstimateGas?: Error;
  providerWaitForTransaction?: providers.TransactionReceipt;
  providerGetBlock?: providers.Block | null;
  providerGetTransactionReceipt?: providers.TransactionReceipt | null;
}

export function createMockMultiProvider(config: MockMultiProviderConfig = {}) {
  const {
    chainMetadata = {},
    signerAddress = TEST_ADDRESSES.signer,
    sendTransactionReceipt = {
      transactionHash:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      blockNumber: 100,
      status: 1,
    } as providers.TransactionReceipt,
    throwOnSendTransaction,
    throwOnEstimateGas,
    providerWaitForTransaction = sendTransactionReceipt,
    providerGetBlock = { number: 150 } as providers.Block,
    providerGetTransactionReceipt = sendTransactionReceipt,
  } = config;

  const mockProvider = {
    waitForTransaction: Sinon.stub().resolves(providerWaitForTransaction),
    getBlock: Sinon.stub().resolves(providerGetBlock),
    getTransactionReceipt: Sinon.stub().resolves(providerGetTransactionReceipt),
  };

  const mockSigner = {
    getAddress: Sinon.stub().resolves(signerAddress),
    sendTransaction: throwOnSendTransaction
      ? Sinon.stub().rejects(throwOnSendTransaction)
      : Sinon.stub().resolves({
          hash: sendTransactionReceipt.transactionHash,
          wait: Sinon.stub().resolves(sendTransactionReceipt),
        }),
  };

  const defaultChainMetadata: ChainMap<Partial<ChainMetadata>> = {
    ethereum: { domainId: 1, blocks: { reorgPeriod: 32 } },
    arbitrum: { domainId: 42161, blocks: { reorgPeriod: 0 } },
  };

  const mergedMetadata = { ...defaultChainMetadata, ...chainMetadata };

  return {
    getChainMetadata: Sinon.stub().callsFake(
      (chain: ChainName) => mergedMetadata[chain] ?? {},
    ),
    getProvider: Sinon.stub().returns(mockProvider),
    getSigner: Sinon.stub().returns(mockSigner),
    estimateGas: throwOnEstimateGas
      ? Sinon.stub().rejects(throwOnEstimateGas)
      : Sinon.stub().resolves(ethers.BigNumber.from(100000)),
    sendTransaction: throwOnSendTransaction
      ? Sinon.stub().rejects(throwOnSendTransaction)
      : Sinon.stub().resolves(sendTransactionReceipt),
    getDomainId: Sinon.stub().callsFake(
      (chain: ChainName) => mergedMetadata[chain]?.domainId ?? 0,
    ),
    _mockProvider: mockProvider,
    _mockSigner: mockSigner,
  } as unknown as MultiProvider & {
    _mockProvider: typeof mockProvider;
    _mockSigner: typeof mockSigner;
  };
}

export function createMockWarpCore(multiProvider: MultiProvider) {
  return {
    multiProvider,
  } as unknown as WarpCore;
}

// Valid EVM test addresses (40 hex chars after 0x)
export const TEST_ADDRESSES: Record<string, string> = {
  ethereum: '0x1111111111111111111111111111111111111111',
  arbitrum: '0x2222222222222222222222222222222222222222',
  optimism: '0x3333333333333333333333333333333333333333',
  polygon: '0x4444444444444444444444444444444444444444',
  bridge: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  signer: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  token: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
};

export function getTestAddress(key: string): string {
  return TEST_ADDRESSES[key] ?? `0x${key.padStart(40, '0').slice(-40)}`;
}

export function buildTestBridges(
  chains: ChainName[] = ['ethereum', 'arbitrum'],
): ChainMap<BridgeConfigWithOverride> {
  return chains.reduce((acc, chain) => {
    acc[chain] = {
      bridge: TEST_ADDRESSES.bridge,
      bridgeIsWarp: false,
      bridgeMinAcceptedAmount: 0,
    };
    return acc;
  }, {} as ChainMap<BridgeConfigWithOverride>);
}

export function buildTestChainMetadata(
  chains: ChainName[] = ['ethereum', 'arbitrum'],
): ChainMap<ChainMetadata> {
  const domainIds: Record<string, number> = {
    ethereum: 1,
    arbitrum: 42161,
    optimism: 10,
    polygon: 137,
  };

  return chains.reduce((acc, chain) => {
    acc[chain] = {
      name: chain,
      chainId: domainIds[chain] ?? 1,
      domainId: domainIds[chain] ?? 1,
      protocol: 'ethereum' as any,
      rpcUrls: [{ http: 'http://localhost:8545' }],
      blocks: { reorgPeriod: chain === 'polygon' ? 'finalized' : 32 },
    } as ChainMetadata;
    return acc;
  }, {} as ChainMap<ChainMetadata>);
}

export interface RebalancerTestContext {
  multiProvider: ReturnType<typeof createMockMultiProvider>;
  warpCore: WarpCore;
  bridges: ChainMap<BridgeConfigWithOverride>;
  chainMetadata: ChainMap<ChainMetadata>;
  tokensByChainName: ChainMap<Token>;
  adapters: ChainMap<ReturnType<typeof createMockAdapter>>;
}

export function createRebalancerTestContext(
  chains: ChainName[] = ['ethereum', 'arbitrum'],
  adapterConfigs: ChainMap<MockAdapterConfig> = {},
): RebalancerTestContext {
  const multiProvider = createMockMultiProvider();
  const warpCore = createMockWarpCore(
    multiProvider as unknown as MultiProvider,
  );
  const bridges = buildTestBridges(chains);
  const chainMetadata = buildTestChainMetadata(chains);

  const adapters: ChainMap<ReturnType<typeof createMockAdapter>> = {};
  const tokensByChainName: ChainMap<Token> = {};

  for (const chain of chains) {
    const adapterConfig = adapterConfigs[chain] ?? {};
    const tokenAddress = getTestAddress(chain);
    const { token, adapter } = createMockToken({
      name: `${chain}Token`,
      addressOrDenom: tokenAddress,
      adapter: createMockAdapter(adapterConfig),
    });
    adapters[chain] = adapter;
    tokensByChainName[chain] = token as unknown as Token;
  }

  for (const originChain of chains) {
    const adapterConfig = adapterConfigs[originChain] ?? {};
    if (adapterConfig.allowedDestination === undefined) {
      const destAddressMap: Record<number, string> = {};
      for (const destChain of chains) {
        if (originChain !== destChain) {
          destAddressMap[chainMetadata[destChain].domainId] =
            getTestAddress(destChain);
        }
      }
      adapters[originChain].getAllowedDestination.callsFake(
        (domainId: number) => {
          return Promise.resolve(
            destAddressMap[domainId] ??
              '0x0000000000000000000000000000000000000000',
          );
        },
      );
    }
  }

  return {
    multiProvider,
    warpCore,
    bridges,
    chainMetadata,
    tokensByChainName,
    adapters,
  };
}

// === Config Builders ===

export function buildTestConfig(
  overrides: Partial<RebalancerConfig> = {},
  chains: string[] = ['chain1'],
): RebalancerConfig {
  const baseChains = chains.reduce(
    (acc, chain) => {
      (acc as any)[chain] = {
        bridgeLockTime: 60 * 1000,
        bridge: ethers.constants.AddressZero,
        weighted: {
          weight: BigInt(1),
          tolerance: BigInt(0),
        },
      };
      return acc;
    },
    {} as Record<string, any>,
  );

  // Build the default strategy config
  const defaultStrategyConfig = {
    rebalanceStrategy: RebalancerStrategyOptions.Weighted,
    chains: baseChains,
  };

  // If overrides has strategyConfig as an array, use it directly
  // Otherwise, wrap single strategy in an array
  let strategyConfig;
  if (overrides.strategyConfig) {
    if (Array.isArray(overrides.strategyConfig)) {
      strategyConfig = overrides.strategyConfig;
    } else {
      // Single strategy override - use it directly wrapped in array
      // If chains is explicitly provided, use it (don't merge with baseChains)
      const singleConfig = overrides.strategyConfig as any;
      strategyConfig = [
        {
          ...singleConfig,
          chains:
            singleConfig.chains !== undefined
              ? singleConfig.chains
              : baseChains,
        },
      ];
    }
  } else {
    strategyConfig = [defaultStrategyConfig];
  }

  // Destructure to exclude strategyConfig from overrides spread
  const { strategyConfig: _, ...restOverrides } = overrides;

  return {
    warpRouteId: 'test-route',
    ...restOverrides,
    strategyConfig,
  } as any as RebalancerConfig;
}

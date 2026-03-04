import { expect } from 'chai';
import { pino } from 'pino';
import Sinon from 'sinon';

import {
  type MultiProtocolProvider,
  MultiProvider,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  DEFAULT_INTENT_TTL_MS,
  RebalancerStrategyOptions,
} from '../config/types.js';
import { TEST_ADDRESSES } from '../test/helpers.js';

import { RebalancerContextFactory } from './RebalancerContextFactory.js';

const testLogger = pino({ level: 'silent' });

function createMockRegistry() {
  return {
    getAddresses: Sinon.stub().resolves({
      ethereum: { mailbox: TEST_ADDRESSES.ethereum },
      arbitrum: { mailbox: TEST_ADDRESSES.arbitrum },
      paradex: { mailbox: TEST_ADDRESSES.polygon },
    }),
    getWarpRoute: Sinon.stub().resolves(null),
    getChainAddresses: Sinon.stub().resolves({
      mailbox: TEST_ADDRESSES.ethereum,
    }),
    getWarpDeployConfig: Sinon.stub().resolves({}),
  } as any;
}

function createMockConfig(): RebalancerConfig {
  return {
    warpRouteId: 'USDC/paradex',
    strategyConfig: [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          ethereum: {
            bridge: TEST_ADDRESSES.bridge,
            bridgeMinAcceptedAmount: 0,
            weighted: { weight: 50n, tolerance: 10n },
          },
          arbitrum: {
            bridge: TEST_ADDRESSES.bridge,
            bridgeMinAcceptedAmount: 0,
            weighted: { weight: 50n, tolerance: 10n },
          },
        },
      },
    ],
    intentTTL: DEFAULT_INTENT_TTL_MS,
  } as RebalancerConfig;
}

describe('RebalancerContextFactory', () => {
  let sandbox: Sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = Sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('create() — non-EVM chain handling', () => {
    it('should skip provider initialization for StarkNet chains', async () => {
      const getProviderStub = Sinon.stub();
      const getProtocolStub = Sinon.stub().callsFake((chain: string) => {
        if (chain === 'paradex') return ProtocolType.Starknet;
        return ProtocolType.Ethereum;
      });

      const multiProvider = {
        getProvider: getProviderStub,
        getProtocol: getProtocolStub,
        metadata: {
          ethereum: {
            name: 'ethereum',
            chainId: 1,
            protocol: ProtocolType.Ethereum,
          },
          arbitrum: {
            name: 'arbitrum',
            chainId: 42161,
            protocol: ProtocolType.Ethereum,
          },
          paradex: {
            name: 'paradex',
            chainId:
              '0x505249564154455f534e5f50415241434c4541525f4d41494e4e4554',
            protocol: ProtocolType.Starknet,
          },
        },
      } as unknown as MultiProvider;

      const mockMpp = {
        extendChainMetadata: Sinon.stub().returnsThis(),
      } as unknown as MultiProtocolProvider;

      const warpCoreConfig: WarpCoreConfig = {
        tokens: [
          {
            chainName: 'ethereum',
            addressOrDenom: TEST_ADDRESSES.ethereum,
            standard: 'EvmHypCollateral',
            decimals: 6,
            symbol: 'USDC',
            name: 'USDC',
          },
          {
            chainName: 'arbitrum',
            addressOrDenom: TEST_ADDRESSES.arbitrum,
            standard: 'EvmHypSynthetic',
            decimals: 6,
            symbol: 'USDC',
            name: 'USDC',
          },
          {
            chainName: 'paradex',
            addressOrDenom: '0xparadex',
            standard: 'StarknetHypSynthetic',
            decimals: 6,
            symbol: 'USDC',
            name: 'USDC',
          },
        ],
        options: {},
      } as any;

      const registry = createMockRegistry();

      await RebalancerContextFactory.create(
        createMockConfig(),
        multiProvider,
        undefined,
        mockMpp,
        registry,
        testLogger,
        warpCoreConfig,
      );

      // getProvider should be called for EVM chains only
      expect(getProviderStub.callCount).to.equal(2);
      const providerChains = getProviderStub.getCalls().map((c) => c.args[0]);
      expect(providerChains).to.include('ethereum');
      expect(providerChains).to.include('arbitrum');
      expect(providerChains).to.not.include('paradex');
    });

    it('should skip provider initialization for Sealevel chains', async () => {
      const getProviderStub = Sinon.stub();
      const getProtocolStub = Sinon.stub().callsFake((chain: string) => {
        if (chain === 'solana') return ProtocolType.Sealevel;
        return ProtocolType.Ethereum;
      });

      const multiProvider = {
        getProvider: getProviderStub,
        getProtocol: getProtocolStub,
        metadata: {
          ethereum: {
            name: 'ethereum',
            chainId: 1,
            protocol: ProtocolType.Ethereum,
          },
          solana: {
            name: 'solana',
            chainId: 'solana-mainnet',
            protocol: ProtocolType.Sealevel,
          },
        },
      } as unknown as MultiProvider;

      const mockMpp = {
        extendChainMetadata: Sinon.stub().returnsThis(),
      } as unknown as MultiProtocolProvider;

      const warpCoreConfig: WarpCoreConfig = {
        tokens: [
          {
            chainName: 'ethereum',
            addressOrDenom: TEST_ADDRESSES.ethereum,
            standard: 'EvmHypCollateral',
            decimals: 6,
            symbol: 'USDC',
            name: 'USDC',
          },
          {
            chainName: 'solana',
            addressOrDenom: 'SolToken111',
            standard: 'SealevelHypSynthetic',
            decimals: 6,
            symbol: 'USDC',
            name: 'USDC',
          },
        ],
        options: {},
      } as any;

      const registry = createMockRegistry();

      await RebalancerContextFactory.create(
        createMockConfig(),
        multiProvider,
        undefined,
        mockMpp,
        registry,
        testLogger,
        warpCoreConfig,
      );

      expect(getProviderStub.callCount).to.equal(1);
      expect(getProviderStub.firstCall.args[0]).to.equal('ethereum');
    });

    it('should call getProvider for all chains when all are EVM', async () => {
      const getProviderStub = Sinon.stub();
      const getProtocolStub = Sinon.stub().returns(ProtocolType.Ethereum);

      const multiProvider = {
        getProvider: getProviderStub,
        getProtocol: getProtocolStub,
        metadata: {
          ethereum: {
            name: 'ethereum',
            chainId: 1,
            protocol: ProtocolType.Ethereum,
          },
          arbitrum: {
            name: 'arbitrum',
            chainId: 42161,
            protocol: ProtocolType.Ethereum,
          },
        },
      } as unknown as MultiProvider;

      const mockMpp = {
        extendChainMetadata: Sinon.stub().returnsThis(),
      } as unknown as MultiProtocolProvider;

      const warpCoreConfig: WarpCoreConfig = {
        tokens: [
          {
            chainName: 'ethereum',
            addressOrDenom: TEST_ADDRESSES.ethereum,
            standard: 'EvmHypCollateral',
            decimals: 6,
            symbol: 'USDC',
            name: 'USDC',
          },
          {
            chainName: 'arbitrum',
            addressOrDenom: TEST_ADDRESSES.arbitrum,
            standard: 'EvmHypSynthetic',
            decimals: 6,
            symbol: 'USDC',
            name: 'USDC',
          },
        ],
        options: {},
      } as any;

      const registry = createMockRegistry();

      await RebalancerContextFactory.create(
        createMockConfig(),
        multiProvider,
        undefined,
        mockMpp,
        registry,
        testLogger,
        warpCoreConfig,
      );

      expect(getProviderStub.callCount).to.equal(2);
      const providerChains = getProviderStub.getCalls().map((c) => c.args[0]);
      expect(providerChains).to.include('ethereum');
      expect(providerChains).to.include('arbitrum');
    });
  });
});

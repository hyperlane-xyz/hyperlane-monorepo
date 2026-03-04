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

function createMockMpp() {
  return {
    extendChainMetadata: Sinon.stub().returnsThis(),
  } as unknown as MultiProtocolProvider;
}

function createToken(
  chainName: string,
  addressOrDenom: string,
  standard: string,
) {
  return {
    chainName,
    addressOrDenom,
    standard,
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  };
}

interface ChainDef {
  name: string;
  chainId: number | string;
  protocol: ProtocolType;
}

function createMockMultiProvider(chains: ChainDef[]) {
  const getProviderStub = Sinon.stub();
  const protocolMap = Object.fromEntries(
    chains.map((c) => [c.name, c.protocol]),
  );
  const getProtocolStub = Sinon.stub().callsFake(
    (chain: string) => protocolMap[chain],
  );
  const metadata = Object.fromEntries(
    chains.map((c) => [
      c.name,
      { name: c.name, chainId: c.chainId, protocol: c.protocol },
    ]),
  );

  return {
    multiProvider: {
      getProvider: getProviderStub,
      getProtocol: getProtocolStub,
      metadata,
    } as unknown as MultiProvider,
    getProviderStub,
  };
}

async function callCreate(
  multiProvider: MultiProvider,
  warpCoreConfig: WarpCoreConfig,
) {
  await RebalancerContextFactory.create(
    createMockConfig(),
    multiProvider,
    undefined,
    createMockMpp(),
    createMockRegistry(),
    testLogger,
    warpCoreConfig,
  );
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
      const { multiProvider, getProviderStub } = createMockMultiProvider([
        { name: 'ethereum', chainId: 1, protocol: ProtocolType.Ethereum },
        { name: 'arbitrum', chainId: 42161, protocol: ProtocolType.Ethereum },
        {
          name: 'paradex',
          chainId: '0x505249564154455f534e5f50415241434c4541525f4d41494e4e4554',
          protocol: ProtocolType.Starknet,
        },
      ]);

      await callCreate(multiProvider, {
        tokens: [
          createToken('ethereum', TEST_ADDRESSES.ethereum, 'EvmHypCollateral'),
          createToken('arbitrum', TEST_ADDRESSES.arbitrum, 'EvmHypSynthetic'),
          createToken('paradex', '0xparadex', 'StarknetHypSynthetic'),
        ],
        options: {},
      } as any);

      expect(getProviderStub.callCount).to.equal(2);
      const providerChains = getProviderStub.getCalls().map((c) => c.args[0]);
      expect(providerChains).to.include('ethereum');
      expect(providerChains).to.include('arbitrum');
      expect(providerChains).to.not.include('paradex');
    });

    it('should skip provider initialization for Sealevel chains', async () => {
      const { multiProvider, getProviderStub } = createMockMultiProvider([
        { name: 'ethereum', chainId: 1, protocol: ProtocolType.Ethereum },
        {
          name: 'solana',
          chainId: 'solana-mainnet' as any,
          protocol: ProtocolType.Sealevel,
        },
      ]);

      await callCreate(multiProvider, {
        tokens: [
          createToken('ethereum', TEST_ADDRESSES.ethereum, 'EvmHypCollateral'),
          createToken('solana', 'SolToken111', 'SealevelHypSynthetic'),
        ],
        options: {},
      } as any);

      expect(getProviderStub.callCount).to.equal(1);
      expect(getProviderStub.firstCall.args[0]).to.equal('ethereum');
    });

    it('should call getProvider for all chains when all are EVM', async () => {
      const { multiProvider, getProviderStub } = createMockMultiProvider([
        { name: 'ethereum', chainId: 1, protocol: ProtocolType.Ethereum },
        { name: 'arbitrum', chainId: 42161, protocol: ProtocolType.Ethereum },
      ]);

      await callCreate(multiProvider, {
        tokens: [
          createToken('ethereum', TEST_ADDRESSES.ethereum, 'EvmHypCollateral'),
          createToken('arbitrum', TEST_ADDRESSES.arbitrum, 'EvmHypSynthetic'),
        ],
        options: {},
      } as any);

      expect(getProviderStub.callCount).to.equal(2);
      const providerChains = getProviderStub.getCalls().map((c) => c.args[0]);
      expect(providerChains).to.include('ethereum');
      expect(providerChains).to.include('arbitrum');
    });
  });
});

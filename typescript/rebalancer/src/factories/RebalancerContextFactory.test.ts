import { expect } from 'chai';
import { pino } from 'pino';
import Sinon from 'sinon';

import { type IRegistry, RegistryType } from '@hyperlane-xyz/registry';
import {
  MultiProtocolProvider,
  MultiProvider,
  TokenStandard,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  DEFAULT_INTENT_TTL_MS,
  RebalancerStrategyOptions,
} from '../config/types.js';
import { TEST_ADDRESSES } from '../test/helpers.js';

import { RebalancerContextFactory } from './RebalancerContextFactory.js';

const testLogger = pino({ level: 'silent' });

function createMockRegistry(): IRegistry {
  return {
    type: RegistryType.Partial,
    uri: 'mock://registry',
    getUri: Sinon.stub().returns('mock://registry'),
    listRegistryContent: Sinon.stub().resolves({
      chains: {},
      deployments: { warpRoutes: {}, warpDeployConfig: {} },
    }),
    getChains: Sinon.stub().resolves([]),
    getMetadata: Sinon.stub().resolves({}),
    getChainMetadata: Sinon.stub().resolves(null),
    getAddresses: Sinon.stub().resolves({
      ethereum: { mailbox: TEST_ADDRESSES.ethereum },
      arbitrum: { mailbox: TEST_ADDRESSES.arbitrum },
      paradex: { mailbox: TEST_ADDRESSES.polygon },
    }),
    getChainAddresses: Sinon.stub().resolves({
      mailbox: TEST_ADDRESSES.ethereum,
    }),
    getChainLogoUri: Sinon.stub().resolves(null),
    addChain: Sinon.stub().resolves(),
    updateChain: Sinon.stub().resolves(),
    removeChain: Sinon.stub().resolves(),
    getWarpRoute: Sinon.stub().resolves(null),
    getWarpRoutes: Sinon.stub().resolves({}),
    addWarpRoute: Sinon.stub().resolves(),
    addWarpRouteConfig: Sinon.stub().resolves(),
    getWarpDeployConfig: Sinon.stub().resolves({}),
    getWarpDeployConfigs: Sinon.stub().resolves({}),
    merge: Sinon.stub().returnsThis(),
  };
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
  const mpp = Sinon.createStubInstance(MultiProtocolProvider);
  mpp.extendChainMetadata.returnsThis();
  return mpp;
}

function createToken(
  chainName: string,
  addressOrDenom: string,
  standard: TokenStandard,
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
  protocol: ProtocolType;
}

function createMockMultiProvider(chains: ChainDef[]) {
  const protocolMap = Object.fromEntries(
    chains.map((c) => [c.name, c.protocol]),
  );

  const multiProvider = Sinon.createStubInstance(MultiProvider);
  multiProvider.getProtocol.callsFake((chain) => {
    const protocol = protocolMap[String(chain)];
    assert(protocol, `No protocol in mock for chain ${chain}`);
    return protocol;
  });

  return { multiProvider };
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
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'arbitrum', protocol: ProtocolType.Ethereum },
        { name: 'paradex', protocol: ProtocolType.Starknet },
      ]);

      await callCreate(multiProvider, {
        tokens: [
          createToken(
            'ethereum',
            TEST_ADDRESSES.ethereum,
            TokenStandard.EvmHypCollateral,
          ),
          createToken(
            'arbitrum',
            TEST_ADDRESSES.arbitrum,
            TokenStandard.EvmHypSynthetic,
          ),
          createToken(
            'paradex',
            '0xparadex',
            TokenStandard.StarknetHypSynthetic,
          ),
        ],
      });

      expect(multiProvider.getProvider.callCount).to.equal(2);
      const providerChains = multiProvider.getProvider
        .getCalls()
        .map((c) => c.args[0]);
      expect(providerChains).to.include('ethereum');
      expect(providerChains).to.include('arbitrum');
      expect(providerChains).to.not.include('paradex');
    });

    it('should skip provider initialization for Sealevel chains', async () => {
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'solana', protocol: ProtocolType.Sealevel },
      ]);

      await callCreate(multiProvider, {
        tokens: [
          createToken(
            'ethereum',
            TEST_ADDRESSES.ethereum,
            TokenStandard.EvmHypCollateral,
          ),
          createToken(
            'solana',
            'SolToken111',
            TokenStandard.SealevelHypSynthetic,
          ),
        ],
      });

      expect(multiProvider.getProvider.callCount).to.equal(1);
      expect(multiProvider.getProvider.firstCall.args[0]).to.equal('ethereum');
    });

    it('should call getProvider for all chains when all are EVM', async () => {
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'arbitrum', protocol: ProtocolType.Ethereum },
      ]);

      await callCreate(multiProvider, {
        tokens: [
          createToken(
            'ethereum',
            TEST_ADDRESSES.ethereum,
            TokenStandard.EvmHypCollateral,
          ),
          createToken(
            'arbitrum',
            TEST_ADDRESSES.arbitrum,
            TokenStandard.EvmHypSynthetic,
          ),
        ],
      });

      expect(multiProvider.getProvider.callCount).to.equal(2);
      const providerChains = multiProvider.getProvider
        .getCalls()
        .map((c) => c.args[0]);
      expect(providerChains).to.include('ethereum');
      expect(providerChains).to.include('arbitrum');
    });
  });
});

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
  ExecutionType,
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

async function createFactory(
  config: RebalancerConfig,
  multiProvider: MultiProvider,
  warpCoreConfig: WarpCoreConfig,
) {
  return RebalancerContextFactory.create(
    config,
    multiProvider,
    createMockMpp(),
    createMockRegistry(),
    testLogger,
    undefined,
    warpCoreConfig,
  );
}

async function callCreate(
  multiProvider: MultiProvider,
  warpCoreConfig: WarpCoreConfig,
) {
  await createFactory(createMockConfig(), multiProvider, warpCoreConfig);
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

    it('should fail early when inventory override origin protocol signer key is missing', async () => {
      const sealevelChain = 'solana';
      const evmChain = 'ethereum';
      const { multiProvider } = createMockMultiProvider([
        { name: evmChain, protocol: ProtocolType.Ethereum },
        { name: sealevelChain, protocol: ProtocolType.Sealevel },
      ]);

      const config = {
        warpRouteId: 'USDC/mixed-route',
        strategyConfig: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              [sealevelChain]: {
                bridge: TEST_ADDRESSES.bridge,
                weighted: { weight: 50n, tolerance: 10n },
                override: {
                  [evmChain]: {
                    executionType: ExecutionType.Inventory,
                  },
                },
              },
              [evmChain]: {
                bridge: TEST_ADDRESSES.bridge,
                weighted: { weight: 50n, tolerance: 10n },
              },
            },
          },
        ],
        inventorySigners: {
          [ProtocolType.Ethereum]: {
            address: TEST_ADDRESSES.ethereum,
            key: '0xabc123',
          },
        },
        intentTTL: DEFAULT_INTENT_TTL_MS,
      } as RebalancerConfig;

      const factory = await createFactory(config, multiProvider, {
        tokens: [
          createToken(
            evmChain,
            TEST_ADDRESSES.ethereum,
            TokenStandard.EvmHypSynthetic,
          ),
          createToken(
            sealevelChain,
            'SolToken1111111111111111111111111111111111111',
            TokenStandard.SealevelHypCollateral,
          ),
        ],
      });

      const getChainMetadataStub = factory.getWarpCore().multiProvider
        .getChainMetadata as Sinon.SinonStub;
      getChainMetadataStub.callsFake((chainName: string) => ({
        protocol:
          chainName === sealevelChain
            ? ProtocolType.Sealevel
            : ProtocolType.Ethereum,
      }));

      await expect(
        (factory as any).createInventoryRebalancerAndConfig({} as any, {}),
      ).to.be.rejectedWith(
        `Missing inventory signer key for protocol ${ProtocolType.Sealevel}`,
      );
    });
  });
  describe('create() — Tron chain metadata validation', () => {
    it('should warn when Tron chain has non-numeric reorgPeriod', async () => {
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'tron', protocol: ProtocolType.Ethereum },
      ]);

      multiProvider.getChainMetadata.callsFake((chain: any) => {
        if (chain === 'tron') {
          return {
            protocol: ProtocolType.Ethereum,
            technicalStack: 'tron',
            blocks: { reorgPeriod: 'finalized' },
          };
        }
        return { protocol: ProtocolType.Ethereum };
      });

      const warnStub = Sinon.stub();
      const mockLogger = {
        debug: Sinon.stub(),
        info: Sinon.stub(),
        warn: warnStub,
        error: Sinon.stub(),
        child: Sinon.stub().returnsThis(),
        level: 'debug',
      } as any;

      await RebalancerContextFactory.create(
        createMockConfig(),
        multiProvider,
        createMockMpp(),
        createMockRegistry(),
        mockLogger,
        undefined,
        {
          tokens: [
            createToken(
              'ethereum',
              TEST_ADDRESSES.ethereum,
              TokenStandard.EvmHypCollateral,
            ),
            createToken(
              'tron',
              TEST_ADDRESSES.arbitrum,
              TokenStandard.EvmHypSynthetic,
            ),
          ],
        },
      );

      const tronWarnings = warnStub
        .getCalls()
        .filter((call: any) => call.args[0]?.chain === 'tron');
      expect(tronWarnings).to.have.length(1);
      expect(tronWarnings[0].args[1]).to.include('reorgPeriod');
    });

    it('should not warn when Tron chain has numeric reorgPeriod', async () => {
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'tron', protocol: ProtocolType.Ethereum },
      ]);

      multiProvider.getChainMetadata.callsFake((chain: any) => {
        if (chain === 'tron') {
          return {
            protocol: ProtocolType.Ethereum,
            technicalStack: 'tron',
            blocks: { reorgPeriod: 1 },
          };
        }
        return { protocol: ProtocolType.Ethereum };
      });

      const warnStub = Sinon.stub();
      const mockLogger = {
        debug: Sinon.stub(),
        info: Sinon.stub(),
        warn: warnStub,
        error: Sinon.stub(),
        child: Sinon.stub().returnsThis(),
        level: 'debug',
      } as any;

      await RebalancerContextFactory.create(
        createMockConfig(),
        multiProvider,
        createMockMpp(),
        createMockRegistry(),
        mockLogger,
        undefined,
        {
          tokens: [
            createToken(
              'ethereum',
              TEST_ADDRESSES.ethereum,
              TokenStandard.EvmHypCollateral,
            ),
            createToken(
              'tron',
              TEST_ADDRESSES.arbitrum,
              TokenStandard.EvmHypSynthetic,
            ),
          ],
        },
      );

      const tronWarnings = warnStub
        .getCalls()
        .filter((call: any) => call.args[0]?.chain === 'tron');
      expect(tronWarnings).to.have.length(0);
    });
  });
});

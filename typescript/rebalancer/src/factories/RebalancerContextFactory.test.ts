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

    it('should fail fast when bridgeMinAcceptedAmount is configured for a chain without a token', async () => {
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'arbitrum', protocol: ProtocolType.Ethereum },
      ]);

      const config = createMockConfig();
      config.strategyConfig[0].chains.arbitrum.bridgeMinAcceptedAmount = 1;

      let error: Error | undefined;
      try {
        const factory = await createFactory(config, multiProvider, {
          tokens: [
            createToken(
              'ethereum',
              TEST_ADDRESSES.ethereum,
              TokenStandard.EvmHypCollateral,
            ),
          ],
        } as WarpCoreConfig);
        await factory.createStrategy();
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).to.equal(
        'No token found for configured strategy chain arbitrum in warp route USDC/paradex',
      );
    });

    it('should fail fast when bridged supply is unavailable during initial collateral calculation', async () => {
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'arbitrum', protocol: ProtocolType.Ethereum },
      ]);

      const factory = await createFactory(createMockConfig(), multiProvider, {
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

      const collateralToken = factory
        .getWarpCore()
        .tokens.find((token) => token.chainName === 'ethereum');
      assert(collateralToken, 'Expected ethereum collateral token in test');

      sandbox.stub(collateralToken, 'getHypAdapter').returns({
        getBridgedSupply: sandbox.stub().resolves(undefined),
      } as any);

      let error: Error | undefined;
      try {
        await factory.createStrategy();
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).to.equal(
        'Missing bridged supply for ethereum while computing initial total collateral for warp route USDC/paradex',
      );
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

      let error: Error | undefined;
      try {
        await (factory as any).createInventoryRebalancerAndConfig(
          {} as any,
          {},
        );
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).to.contain(
        `Missing inventory signer key for protocol ${ProtocolType.Sealevel}`,
      );
    });

    it('should fail early when an inventory-relevant chain has no token', async () => {
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'arbitrum', protocol: ProtocolType.Ethereum },
      ]);

      const config = {
        ...createMockConfig(),
        inventorySigners: {
          [ProtocolType.Ethereum]: {
            address: TEST_ADDRESSES.ethereum,
            key: '0xabc123',
          },
        },
      } as RebalancerConfig;
      config.strategyConfig[0].chains.arbitrum.executionType =
        ExecutionType.Inventory;

      const factory = await createFactory(config, multiProvider, {
        tokens: [
          createToken(
            'ethereum',
            TEST_ADDRESSES.ethereum,
            TokenStandard.EvmHypCollateral,
          ),
        ],
      });

      const getChainMetadataStub = factory.getWarpCore().multiProvider
        .getChainMetadata as Sinon.SinonStub;
      getChainMetadataStub.callsFake(() => ({
        protocol: ProtocolType.Ethereum,
      }));

      let error: Error | undefined;
      try {
        await (factory as any).createInventoryRebalancerAndConfig(
          {} as any,
          {},
        );
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).to.equal(
        'No token found for inventory-relevant chain arbitrum in warp route USDC/paradex',
      );
    });

    it('should fail early when inventory chain uses unsupported protocol', async () => {
      const cosmosChain = 'cosmoshub';
      const evmChain = 'ethereum';
      const { multiProvider } = createMockMultiProvider([
        { name: evmChain, protocol: ProtocolType.Ethereum },
        { name: cosmosChain, protocol: ProtocolType.Cosmos },
      ]);

      const config = {
        warpRouteId: 'USDC/cosmos-route',
        strategyConfig: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              [cosmosChain]: {
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
          [ProtocolType.Cosmos]: {
            address: 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu',
            key: 'cosmos_key',
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
            cosmosChain,
            'cosmos1token',
            TokenStandard.EvmHypSynthetic,
          ),
        ],
      });

      const getChainMetadataStub = factory.getWarpCore().multiProvider
        .getChainMetadata as Sinon.SinonStub;
      getChainMetadataStub.callsFake((chainName: string) => ({
        protocol:
          chainName === cosmosChain
            ? ProtocolType.Cosmos
            : ProtocolType.Ethereum,
      }));

      let error: Error | undefined;
      try {
        await (factory as any).createInventoryRebalancerAndConfig(
          {} as any,
          {},
        );
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).to.contain(
        `Inventory rebalancing does not support protocol '${ProtocolType.Cosmos}'`,
      );
    });
  });
});

import { expect } from 'chai';
import { Wallet } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import { type IRegistry, RegistryType } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainMetadata,
  MultiProtocolProvider,
  MultiProvider,
  TokenStandard,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import type { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  DEFAULT_INTENT_TTL_MS,
  ExecutionType,
  ExternalBridgeType,
  RebalancerStrategyOptions,
} from '../config/types.js';
import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import { TEST_ADDRESSES } from '../test/helpers.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';

import { RebalancerContextFactory } from './RebalancerContextFactory.js';

const testLogger = pino({ level: 'silent' });

function createMockExternalBridge(): IExternalBridge {
  return {
    externalBridgeId: ExternalBridgeType.LiFi,
    logger: testLogger,
    quote: Sinon.stub(),
    execute: Sinon.stub(),
    getStatus: Sinon.stub(),
  };
}

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

function createEvmMultiProtocolProvider(
  chainNames: string[],
): MultiProtocolProvider {
  const metadata: ChainMap<ChainMetadata> = {};
  chainNames.forEach((name, index) => {
    const chainId = index + 1;
    metadata[name] = {
      chainId,
      domainId: chainId,
      name,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: `http://${name}.invalid` }],
    };
  });
  return new MultiProtocolProvider(metadata);
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
  options: {
    inventorySignerKeysByProtocol?: Partial<Record<ProtocolType, string>>;
    externalBridgeApiKeys?: Partial<Record<ExternalBridgeType, string>>;
    multiProtocolProvider?: MultiProtocolProvider;
  } = {},
) {
  return RebalancerContextFactory.create(
    config,
    multiProvider,
    options.multiProtocolProvider ?? createMockMpp(),
    createMockRegistry(),
    testLogger,
    options.inventorySignerKeysByProtocol,
    options.externalBridgeApiKeys,
    warpCoreConfig,
  );
}

function createMockActionTracker(): IActionTracker {
  return {
    initialize: Sinon.stub().resolves(),
    createRebalanceIntent: Sinon.stub().resolves(),
    createRebalanceAction: Sinon.stub().resolves(),
    completeRebalanceAction: Sinon.stub().resolves(),
    failRebalanceAction: Sinon.stub().resolves(),
    completeRebalanceIntent: Sinon.stub().resolves(),
    cancelRebalanceIntent: Sinon.stub().resolves(),
    failRebalanceIntent: Sinon.stub().resolves(),
    syncTransfers: Sinon.stub().resolves(),
    syncRebalanceIntents: Sinon.stub().resolves(),
    syncRebalanceActions: Sinon.stub().resolves(),
    syncInventoryMovementActions: Sinon.stub().resolves({
      completed: 0,
      failed: 0,
    }),
    logStoreContents: Sinon.stub().resolves(),
    getInProgressTransfers: Sinon.stub().resolves([]),
    getActiveRebalanceIntents: Sinon.stub().resolves([]),
    getTransfersByDestination: Sinon.stub().resolves([]),
    getRebalanceIntentsByDestination: Sinon.stub().resolves([]),
    getTransfer: Sinon.stub().resolves(undefined),
    getRebalanceIntent: Sinon.stub().resolves(undefined),
    getRebalanceAction: Sinon.stub().resolves(undefined),
    getInProgressActions: Sinon.stub().resolves([]),
    getPartiallyFulfilledInventoryIntents: Sinon.stub().resolves([]),
    getActionsByType: Sinon.stub().resolves([]),
    getActionsForIntent: Sinon.stub().resolves([]),
    getInflightInventoryMovements: Sinon.stub().resolves(0n),
  };
}

async function getErrorMessage(
  operation: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

    it('should initialize providers for Tron chains (EVM-like)', async () => {
      const { multiProvider } = createMockMultiProvider([
        { name: 'ethereum', protocol: ProtocolType.Ethereum },
        { name: 'tron', protocol: ProtocolType.Tron },
      ]);

      await callCreate(multiProvider, {
        tokens: [
          createToken(
            'ethereum',
            TEST_ADDRESSES.ethereum,
            TokenStandard.EvmHypCollateral,
          ),
          createToken(
            'tron',
            '0xTronToken1234567890',
            TokenStandard.TronHypCollateral,
          ),
        ],
      });

      // Tron is EVM-like, so getProvider should be called for both chains
      expect(multiProvider.getProvider.callCount).to.equal(2);
      const providerChains = multiProvider.getProvider
        .getCalls()
        .map((c) => c.args[0]);
      expect(providerChains).to.include('ethereum');
      expect(providerChains).to.include('tron');
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
            TokenStandard.EvmHypCollateral,
          ),
          createToken(
            sealevelChain,
            'SolToken1111111111111111111111111111111111111',
            TokenStandard.SealevelHypCollateral,
          ),
        ],
      });

      // Stubbed test method; accessing Sinon controls does not invoke it unbound.
      // oxlint-disable-next-line typescript-eslint/unbound-method
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

      // Stubbed test method; accessing Sinon controls does not invoke it unbound.
      // oxlint-disable-next-line typescript-eslint/unbound-method
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

    it('should accept Tron as a supported inventory protocol', async () => {
      const tronChain = 'tron';
      const evmChain = 'ethereum';
      const { multiProvider } = createMockMultiProvider([
        { name: evmChain, protocol: ProtocolType.Ethereum },
        { name: tronChain, protocol: ProtocolType.Tron },
      ]);

      const config = {
        warpRouteId: 'USDC/tron-route',
        strategyConfig: [
          {
            rebalanceStrategy: RebalancerStrategyOptions.Weighted,
            chains: {
              [tronChain]: {
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
          [ProtocolType.Tron]: {
            address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            key: '0xdef456',
          },
        },
        intentTTL: DEFAULT_INTENT_TTL_MS,
      } as RebalancerConfig;

      const factory = await createFactory(config, multiProvider, {
        tokens: [
          createToken(
            evmChain,
            TEST_ADDRESSES.ethereum,
            TokenStandard.EvmHypCollateral,
          ),
          createToken(
            tronChain,
            '0xTronToken123',
            TokenStandard.TronHypCollateral,
          ),
        ],
      });

      // Stubbed test method; accessing Sinon controls does not invoke it unbound.
      // oxlint-disable-next-line typescript-eslint/unbound-method
      const getChainMetadataStub = factory.getWarpCore().multiProvider
        .getChainMetadata as Sinon.SinonStub;
      getChainMetadataStub.callsFake((chainName: string) => ({
        protocol:
          chainName === tronChain ? ProtocolType.Tron : ProtocolType.Ethereum,
      }));

      const result = await (factory as any).createInventoryRebalancerAndConfig(
        {} as any,
        {},
      );

      assert(
        result,
        'Expected inventory config to be created for Tron support',
      );
      expect(result.inventoryConfig.inventoryAddresses).to.deep.equal({
        [ProtocolType.Ethereum]: TEST_ADDRESSES.ethereum,
        [ProtocolType.Tron]: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      });
      expect(result.inventoryConfig.chains).to.include.members([
        evmChain,
        tronChain,
      ]);
      expect(result.inventoryRebalancer).to.exist;
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

      // Stubbed test method; accessing Sinon controls does not invoke it unbound.
      // oxlint-disable-next-line typescript-eslint/unbound-method
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

  describe('manual inventory creation', () => {
    const inventoryPrivateKey =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const inventoryChains = ['ethereum', 'arbitrum'];

    function createInventoryWarpConfig(): WarpCoreConfig {
      return {
        tokens: inventoryChains.map((chainName) =>
          createToken(
            chainName,
            chainName === 'ethereum'
              ? TEST_ADDRESSES.ethereum
              : TEST_ADDRESSES.arbitrum,
            TokenStandard.EvmHypCollateral,
          ),
        ),
      };
    }

    async function createManualFactory(
      options: {
        includeKeys?: boolean;
        swapsXyzApiKey?: string;
        warpCoreConfig?: WarpCoreConfig;
      } = {},
    ): Promise<RebalancerContextFactory> {
      const { multiProvider } = createMockMultiProvider(
        inventoryChains.map((name) => ({
          name,
          protocol: ProtocolType.Ethereum,
        })),
      );
      return createFactory(
        createMockConfig(),
        multiProvider,
        options.warpCoreConfig ?? createInventoryWarpConfig(),
        {
          inventorySignerKeysByProtocol:
            options.includeKeys === false
              ? undefined
              : { [ProtocolType.Ethereum]: inventoryPrivateKey },
          externalBridgeApiKeys: options.swapsXyzApiKey
            ? { [ExternalBridgeType.SwapsXyz]: options.swapsXyzApiKey }
            : undefined,
          multiProtocolProvider:
            createEvmMultiProtocolProvider(inventoryChains),
        },
      );
    }

    it('creates inventory components from runtime keys and additional chains', async () => {
      const factory = await createManualFactory();

      const result = await factory.createManualInventoryContext({
        origin: 'ethereum',
        destination: 'arbitrum',
        externalBridge: ExternalBridgeType.LiFi,
        actionTracker: createMockActionTracker(),
        externalBridgeRegistryOverride: {
          [ExternalBridgeType.LiFi]: createMockExternalBridge(),
        },
      });

      expect(result.inventoryRebalancer.rebalancerType).to.equal('inventory');
      expect(result.inventoryConfig.chains).to.have.members(inventoryChains);
      expect(result.inventoryConfig.inventoryAddresses).to.deep.equal({
        [ProtocolType.Ethereum]: new Wallet(inventoryPrivateKey).address,
      });
    });

    it('requires runtime or YAML inventory signers in manual mode', async () => {
      const factory = await createManualFactory({ includeKeys: false });

      const error = await getErrorMessage(() =>
        factory.createManualInventoryContext({
          origin: 'ethereum',
          destination: 'arbitrum',
          externalBridge: ExternalBridgeType.LiFi,
          actionTracker: createMockActionTracker(),
          externalBridgeRegistryOverride: {
            [ExternalBridgeType.LiFi]: createMockExternalBridge(),
          },
        }),
      );

      expect(error).to.contain('HYP_INVENTORY_KEY_<PROTOCOL>');
    });

    it('synthesizes required swapsxyz configuration when an API key exists', async () => {
      const factory = await createManualFactory({
        swapsXyzApiKey: 'test-api-key',
      });

      const result = await factory.createManualInventoryContext({
        origin: 'ethereum',
        destination: 'arbitrum',
        externalBridge: ExternalBridgeType.SwapsXyz,
        actionTracker: createMockActionTracker(),
      });

      expect(result.externalBridgeRegistry[ExternalBridgeType.SwapsXyz]).to
        .exist;
    });

    it('requires SWAPSXYZ_API_KEY for synthesized swapsxyz configuration', async () => {
      const factory = await createManualFactory();

      const error = await getErrorMessage(() =>
        factory.createManualInventoryContext({
          origin: 'ethereum',
          destination: 'arbitrum',
          externalBridge: ExternalBridgeType.SwapsXyz,
          actionTracker: createMockActionTracker(),
        }),
      );

      expect(error).to.contain('SWAPSXYZ_API_KEY is not set');
    });

    it('requires a LiFi integrator when LiFi is required manually', async () => {
      const factory = await createManualFactory();

      const error = await getErrorMessage(() =>
        factory.createManualInventoryContext({
          origin: 'ethereum',
          destination: 'arbitrum',
          externalBridge: ExternalBridgeType.LiFi,
          actionTracker: createMockActionTracker(),
        }),
      );

      expect(error).to.contain('integrator is not configured');
    });

    it('rejects an additional chain missing from the warp route', async () => {
      const factory = await createManualFactory();

      const error = await getErrorMessage(() =>
        factory.createManualInventoryContext({
          origin: 'ethereum',
          destination: 'optimism',
          externalBridge: ExternalBridgeType.LiFi,
          actionTracker: createMockActionTracker(),
          externalBridgeRegistryOverride: {
            [ExternalBridgeType.LiFi]: createMockExternalBridge(),
          },
        }),
      );

      expect(error).to.contain(
        'No token found for inventory-relevant chain optimism',
      );
    });

    it('skips inventory components without runtime or YAML signers', async () => {
      const factory = await createManualFactory({ includeKeys: false });

      const result = await factory.createRebalancers({
        actionTracker: createMockActionTracker(),
      });

      expect(result.rebalancers.some((r) => r.rebalancerType === 'inventory'))
        .to.be.false;
      expect(result.inventoryConfig).to.be.undefined;
    });
  });
});

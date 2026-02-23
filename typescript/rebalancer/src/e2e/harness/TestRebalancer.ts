import { pad, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type Logger, pino } from 'pino';

import { ERC20Test__factory } from '@hyperlane-xyz/core';
import {
  HyperlaneCore,
  LocalAccountViemSigner,
  MultiProtocolProvider,
  type MultiProvider,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert, ensure0x } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../../config/RebalancerConfig.js';
import {
  DEFAULT_INTENT_TTL_MS,
  ExternalBridgeType,
  type StrategyConfig,
  getStrategyChainNames,
} from '../../config/types.js';
import {
  RebalancerOrchestrator,
  type RebalancerOrchestratorDeps,
} from '../../core/RebalancerOrchestrator.js';
import { RebalancerContextFactory } from '../../factories/RebalancerContextFactory.js';
import type { ExternalBridgeRegistry } from '../../interfaces/IExternalBridge.js';
import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { IStrategy } from '../../interfaces/IStrategy.js';
import type { InventoryMonitorConfig, Monitor } from '../../monitor/Monitor.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { ExplorerMessage } from '../../utils/ExplorerClient.js';
import {
  ANVIL_TEST_PRIVATE_KEY,
  BALANCE_PRESETS,
  DOMAIN_IDS,
  type DeployedAddresses,
  ERC20_INVENTORY_MONITORED_ROUTE_ID,
  type Erc20InventoryDeployedAddresses,
  INVENTORY_SIGNER_PRESETS,
  MONITORED_ROUTE_ID,
  NATIVE_MONITORED_ROUTE_ID,
  type NativeDeployedAddresses,
  TEST_CHAINS,
  type TestChain,
  buildErc20InventoryWarpRouteConfig,
  buildNativeWarpRouteConfig,
  buildWarpRouteConfig,
} from '../fixtures/routes.js';

import { setupCollateralBalances } from './BridgeSetup.js';
import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';
import { ForkIndexer } from './ForkIndexer.js';
import {
  MockExplorerClient,
  type MockExplorerConfig,
} from './MockExplorerClient.js';
import { MockExternalBridge } from './MockExternalBridge.js';

function encodeWarpRouteMessageBody(
  recipient: string,
  amount: bigint,
): string {
  const recipientBytes32 = addressToBytes32(recipient);
  const amountHex = pad(toHex(amount), { size: 32 });
  return recipientBytes32 + amountHex.slice(2);
}

export interface PendingTransferParams {
  from: TestChain;
  to: TestChain;
  amount: bigint;
  warpRecipient?: string;
}

export interface TestRebalancerContext {
  orchestrator: RebalancerOrchestrator;
  strategy: IStrategy;
  tracker: IActionTracker;
  mockExplorer: MockExplorerClient;
  forkIndexer: ForkIndexer;
  multiProvider: MultiProvider;
  rebalancerConfig: RebalancerConfig;
  contextFactory: RebalancerContextFactory;
  inventoryConfig?: InventoryMonitorConfig;
  createMonitor(checkFrequency: number): Monitor;
  getConfirmedBlockTags(): Promise<ConfirmedBlockTags>;
}

type BalancePreset = keyof typeof BALANCE_PRESETS;
type BalanceConfig = BalancePreset | Record<string, bigint>;
type ExecutionMode = 'propose' | 'execute';
type InventorySignerPreset = keyof typeof INVENTORY_SIGNER_PRESETS;
type InventorySignerBalanceConfig =
  | InventorySignerPreset
  | Partial<Record<string, bigint>>;

type TestInventoryConfig = {
  inventorySignerKey: string;
  nativeDeployedAddresses: NativeDeployedAddresses;
};

type TestErc20InventoryConfig = {
  inventorySignerKey: string;
  erc20DeployedAddresses: Erc20InventoryDeployedAddresses;
};

export class TestRebalancerBuilder {
  private strategyConfig: StrategyConfig[] | undefined;
  private balanceConfig: BalanceConfig = 'BALANCED';
  private pendingTransfers: PendingTransferParams[] = [];
  private mockTransfers: ExplorerMessage[] = [];
  private executionMode: ExecutionMode = 'propose';
  private inventoryConfig: TestInventoryConfig | undefined;
  private erc20InventoryConfig: TestErc20InventoryConfig | undefined;
  private mockExternalBridge: MockExternalBridge | undefined;
  private readonly logger: Logger;
  private inventorySignerBalanceConfig:
    | InventorySignerBalanceConfig
    | undefined;

  constructor(
    private readonly deploymentManager: BaseLocalDeploymentManager<
      DeployedAddresses | NativeDeployedAddresses
    >,
    private readonly multiProvider: MultiProvider,
  ) {
    this.logger = pino({ level: 'debug' }).child({ module: 'TestRebalancer' });
  }

  withStrategy(config: StrategyConfig[]): this {
    this.strategyConfig = config;
    return this;
  }

  withBalances(preset: BalancePreset | Record<string, bigint>): this {
    this.balanceConfig = preset;
    return this;
  }

  withPendingTransfer(params: PendingTransferParams): this {
    this.pendingTransfers.push(params);
    return this;
  }

  withMockTransfer(message: ExplorerMessage): this {
    this.mockTransfers.push(message);
    return this;
  }

  withExecutionMode(mode: ExecutionMode): this {
    this.executionMode = mode;
    return this;
  }

  withInventoryConfig(config: {
    inventorySignerKey: string;
    nativeDeployedAddresses: NativeDeployedAddresses;
  }): this {
    this.inventoryConfig = config;
    return this;
  }

  withErc20InventoryConfig(config: TestErc20InventoryConfig): this {
    this.erc20InventoryConfig = config;
    return this;
  }

  withMockExternalBridge(bridge: MockExternalBridge): this {
    this.mockExternalBridge = bridge;
    return this;
  }

  withInventorySignerBalances(config: InventorySignerBalanceConfig): this {
    this.inventorySignerBalanceConfig = config;
    return this;
  }

  private async computeConfirmedBlockTags(): Promise<ConfirmedBlockTags> {
    const blockTags: ConfirmedBlockTags = {};
    const localProviders = this.deploymentManager.getContext().providers;

    for (const [chain, provider] of localProviders) {
      try {
        const blockNumber = await provider.send('eth_blockNumber', []);
        blockTags[chain] = parseInt(blockNumber, 16);
        this.logger.debug(
          { chain, blockNumber: blockTags[chain] },
          'Computed confirmed block tag',
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chain,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to get block number, using undefined',
        );
        blockTags[chain] = undefined;
      }
    }

    return blockTags;
  }

  async build(): Promise<TestRebalancerContext> {
    if (!this.strategyConfig || this.strategyConfig.length === 0) {
      throw new Error(
        'Strategy config is required. Call withStrategy() before build().',
      );
    }

    const strategyChains = getStrategyChainNames(this.strategyConfig);
    const balanceChains = this.getBalanceChains();
    const missingChains = strategyChains.filter(
      (chain) => !balanceChains.includes(chain),
    );
    if (missingChains.length > 0) {
      throw new Error(
        `Balance config missing chains required by strategy: ${missingChains.join(', ')}. ` +
          `Strategy chains: ${strategyChains.join(', ')}, Balance chains: ${balanceChains.join(', ')}`,
      );
    }

    assert(
      !(this.inventoryConfig && this.erc20InventoryConfig),
      'Cannot set both inventoryConfig and erc20InventoryConfig — use one or the other',
    );

    if (this.inventoryConfig && !this.mockExternalBridge) {
      throw new Error(
        'Inventory mode requires .withMockExternalBridge() to prevent hitting real external bridges in tests',
      );
    }

    await this.setupBalances();

    const inventoryModeConfig = this.inventoryConfig;
    const erc20InventoryModeConfig = this.erc20InventoryConfig;
    const isInventoryMode = inventoryModeConfig !== undefined;
    const isErc20InventoryMode = erc20InventoryModeConfig !== undefined;
    const ctx = this.deploymentManager.getContext();
    const { providers: localProviders } = ctx;
    const deployedAddresses = ctx.deployedAddresses;
    if (!isInventoryMode && !('tokens' in deployedAddresses)) {
      throw new Error('Expected ERC20 deployed addresses with tokens field');
    }

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      const chainAddresses = isErc20InventoryMode
        ? erc20InventoryModeConfig.erc20DeployedAddresses.chains[chain]
        : isInventoryMode
          ? inventoryModeConfig.nativeDeployedAddresses.chains[chain]
          : deployedAddresses.chains[chain];
      if (!chainAddresses) {
        throw new Error(`Missing chain addresses for ${chain}`);
      }
      coreAddresses[chain] = {
        mailbox: chainAddresses.mailbox,
        interchainSecurityModule: chainAddresses.ism,
      };
    }
    const hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      this.multiProvider,
    );

    const deployerWallet = new LocalAccountViemSigner(
      ensure0x(ANVIL_TEST_PRIVATE_KEY),
    );
    const rebalancerAddresses = [await deployerWallet.getAddress()];

    const workingMultiProvider = await this.getWorkingMultiProvider();

    const forkIndexer = new ForkIndexer(
      localProviders,
      hyperlaneCore,
      rebalancerAddresses,
      this.logger,
    );

    const confirmedBlockTags = await this.computeConfirmedBlockTags();
    await forkIndexer.initialize(confirmedBlockTags);

    const mockExplorer = new MockExplorerClient(
      this.buildMockExplorerConfig(),
      forkIndexer,
      () => this.computeConfirmedBlockTags(),
    );

    const registry = this.deploymentManager.getRegistry();
    const mpp = MultiProtocolProvider.fromMultiProvider(workingMultiProvider);

    let inventoryMultiProvider: MultiProvider | undefined;
    let rebalancerConfig: RebalancerConfig;
    let warpCoreConfig: WarpCoreConfig;
    if (isErc20InventoryMode) {
      inventoryMultiProvider =
        await this.getInventoryMultiProvider(localProviders);
      const inventorySignerAddress = privateKeyToAccount(
        ensure0x(erc20InventoryModeConfig.inventorySignerKey),
      ).address;
      rebalancerAddresses.push(inventorySignerAddress);
      rebalancerConfig = new RebalancerConfig(
        ERC20_INVENTORY_MONITORED_ROUTE_ID,
        this.strategyConfig,
        DEFAULT_INTENT_TTL_MS,
        inventorySignerAddress,
        { lifi: { integrator: 'test' } },
      );
      warpCoreConfig = buildErc20InventoryWarpRouteConfig(
        erc20InventoryModeConfig.erc20DeployedAddresses,
      );
    } else if (isInventoryMode) {
      inventoryMultiProvider =
        await this.getInventoryMultiProvider(localProviders);
      const inventorySignerAddress = privateKeyToAccount(
        ensure0x(inventoryModeConfig.inventorySignerKey),
      ).address;
      rebalancerAddresses.push(inventorySignerAddress);
      rebalancerConfig = new RebalancerConfig(
        NATIVE_MONITORED_ROUTE_ID,
        this.strategyConfig,
        DEFAULT_INTENT_TTL_MS,
        inventorySignerAddress,
        { lifi: { integrator: 'test' } },
      );
      warpCoreConfig = buildNativeWarpRouteConfig(
        inventoryModeConfig.nativeDeployedAddresses,
      );
    } else {
      if (!('tokens' in deployedAddresses)) {
        throw new Error('Expected ERC20 deployed addresses with tokens field');
      }
      rebalancerConfig = new RebalancerConfig(
        MONITORED_ROUTE_ID,
        this.strategyConfig,
        DEFAULT_INTENT_TTL_MS,
      );
      warpCoreConfig = buildWarpRouteConfig(deployedAddresses);
    }

    const contextFactory = await RebalancerContextFactory.create(
      rebalancerConfig,
      workingMultiProvider,
      inventoryMultiProvider,
      mpp,
      registry,
      this.logger,
      warpCoreConfig,
    );

    const strategy = await contextFactory.createStrategy();
    const { tracker, adapter } =
      await contextFactory.createActionTracker(mockExplorer);

    await tracker.initialize();
    this.logger.info('ActionTracker initialized with mock explorer');

    const isAnyInventoryMode = isInventoryMode || isErc20InventoryMode;
    const externalBridgeRegistryOverride =
      isAnyInventoryMode && this.mockExternalBridge
        ? ({
            [ExternalBridgeType.LiFi]: this.mockExternalBridge,
          } as Partial<ExternalBridgeRegistry>)
        : undefined;
    const rebalancerComponents =
      this.executionMode === 'execute' || isAnyInventoryMode
        ? await contextFactory.createRebalancers(
            tracker,
            undefined,
            externalBridgeRegistryOverride,
          )
        : undefined;
    const rebalancers =
      this.executionMode === 'execute'
        ? (rebalancerComponents?.rebalancers ?? [])
        : [];
    const inventoryConfig = rebalancerComponents?.inventoryConfig;
    const externalBridgeRegistry = rebalancerComponents?.externalBridgeRegistry;

    const orchestratorDeps: RebalancerOrchestratorDeps = {
      strategy,
      rebalancers,
      actionTracker: tracker,
      inflightContextAdapter: adapter,
      rebalancerConfig,
      externalBridgeRegistry,
      logger: this.logger,
    };
    const orchestrator = new RebalancerOrchestrator(orchestratorDeps);

    return {
      orchestrator,
      strategy,
      tracker,
      mockExplorer,
      forkIndexer,
      multiProvider: workingMultiProvider,
      rebalancerConfig,
      contextFactory,
      inventoryConfig,
      createMonitor: (checkFrequency: number) =>
        contextFactory.createMonitor(checkFrequency, inventoryConfig),
      getConfirmedBlockTags: () => this.computeConfirmedBlockTags(),
    };
  }

  private getBalanceChains(): string[] {
    if (typeof this.balanceConfig === 'string') {
      return Object.keys(BALANCE_PRESETS[this.balanceConfig]);
    }
    return Object.keys(this.balanceConfig);
  }

  private getBalances(): Record<string, bigint> {
    if (typeof this.balanceConfig === 'string') {
      const preset = BALANCE_PRESETS[this.balanceConfig];
      return Object.fromEntries(
        Object.entries(preset).map(([chain, value]) => [chain, BigInt(value)]),
      ) as Record<string, bigint>;
    }
    return this.balanceConfig;
  }

  private async setupBalances(): Promise<void> {
    const balances = this.getBalances();
    const ctx = this.deploymentManager.getContext();
    const { providers: localProviders } = ctx;

    if (this.inventoryConfig) {
      for (const [chain, balance] of Object.entries(balances)) {
        const provider = localProviders.get(chain);
        const monitoredRouteAddress =
          this.inventoryConfig.nativeDeployedAddresses.monitoredRoute[
            chain as TestChain
          ];
        if (!provider) {
          throw new Error(
            `Missing local provider for inventory chain ${chain}`,
          );
        }
        if (!monitoredRouteAddress) {
          throw new Error(
            `Missing monitored route address for inventory chain ${chain}`,
          );
        }

        await provider.send('anvil_setBalance', [
          monitoredRouteAddress,
          toHex(balance),
        ]);
      }

      this.logger.info(
        {
          balances: Object.fromEntries(
            Object.entries(balances).map(([chain, balance]) => [
              chain,
              balance.toString(),
            ]),
          ),
        },
        'Inventory balances configured on monitored routes',
      );
      await this.setupInventorySignerBalances(localProviders);
      return;
    }

    if (this.erc20InventoryConfig) {
      for (const [chain, balance] of Object.entries(balances)) {
        const provider = localProviders.get(chain);
        const tokenAddress: string | undefined =
          this.erc20InventoryConfig.erc20DeployedAddresses.tokens[
            chain as TestChain
          ];
        const monitoredRouteAddress: string | undefined =
          this.erc20InventoryConfig.erc20DeployedAddresses.monitoredRoute[
            chain as TestChain
          ];
        assert(provider, `setupBalances: missing provider for chain ${chain}`);
        assert(
          tokenAddress,
          `setupBalances: missing token address for chain ${chain}`,
        );
        assert(
          monitoredRouteAddress,
          `setupBalances: missing monitored route address for chain ${chain}`,
        );

        const deployerSigner = new LocalAccountEvmSigner(
          ensure0x(ANVIL_TEST_PRIVATE_KEY),
        ).connect(provider as any);
        const token = ERC20Test__factory.connect(tokenAddress, deployerSigner);
        await token.transfer(monitoredRouteAddress, balance);
      }

      this.logger.info(
        {
          balances: Object.fromEntries(
            Object.entries(balances).map(([chain, balance]) => [
              chain,
              balance.toString(),
            ]),
          ),
        },
        'ERC20 inventory balances configured on monitored routes',
      );
      await this.setupInventorySignerBalances(localProviders);
      return;
    }

    const deployedAddresses = ctx.deployedAddresses;
    if (!('tokens' in deployedAddresses)) {
      throw new Error('Expected ERC20 deployed addresses with tokens field');
    }

    await setupCollateralBalances(
      localProviders,
      balances,
      deployedAddresses.monitoredRoute,
      deployedAddresses.tokens,
      ANVIL_TEST_PRIVATE_KEY,
    );

    this.logger.info(
      {
        balances: Object.fromEntries(
          Object.entries(balances).map(([chain, balance]) => [
            chain,
            balance.toString(),
          ]),
        ),
      },
      'Collateral balances configured',
    );
  }

  private getInventorySignerAddress(): string {
    const config = this.inventoryConfig ?? this.erc20InventoryConfig;
    assert(config, 'Expected inventoryConfig or erc20InventoryConfig');
    return privateKeyToAccount(ensure0x(config.inventorySignerKey)).address;
  }

  private async setupInventorySignerBalances(
    localProviders: Map<string, ReturnType<MultiProvider['getProvider']>>,
  ): Promise<void> {
    if (
      !this.inventorySignerBalanceConfig ||
      (!this.inventoryConfig && !this.erc20InventoryConfig)
    ) {
      return;
    }

    const signerAddress = this.getInventorySignerAddress();

    let balances: Partial<Record<string, string>>;
    if (typeof this.inventorySignerBalanceConfig === 'string') {
      balances = INVENTORY_SIGNER_PRESETS[this.inventorySignerBalanceConfig];
    } else {
      balances = Object.fromEntries(
        Object.entries(this.inventorySignerBalanceConfig)
          .filter((entry): entry is [string, bigint] => entry[1] !== undefined)
          .map(([chain, val]) => [chain, val.toString()]),
      );
    }

    if (this.erc20InventoryConfig) {
      const signerWallet = new LocalAccountEvmSigner(
        ensure0x(this.erc20InventoryConfig.inventorySignerKey),
      );
      const deployerKey = ANVIL_TEST_PRIVATE_KEY;
      const tokens = this.erc20InventoryConfig.erc20DeployedAddresses.tokens;

      for (const [chain, balance] of Object.entries(balances)) {
        const provider = localProviders.get(chain);
        assert(
          balance !== undefined,
          `setupInventorySignerBalances: missing balance for chain ${chain}`,
        );
        assert(
          provider,
          `setupInventorySignerBalances: missing provider for chain ${chain}`,
        );

        const tokenAddress = tokens[chain as TestChain];
        assert(
          tokenAddress,
          `setupInventorySignerBalances: missing token address for chain ${chain}`,
        );

        const connectedSigner = signerWallet.connect(provider as any);
        const deployerSigner = new LocalAccountEvmSigner(
          ensure0x(deployerKey),
        ).connect(provider as any);
        const deployerAddress = await deployerSigner.getAddress();
        const tokenAsSigner = ERC20Test__factory.connect(
          tokenAddress,
          connectedSigner,
        );
        const tokenAsDeployer = ERC20Test__factory.connect(
          tokenAddress,
          deployerSigner,
        );

        const current = await tokenAsSigner.balanceOf(signerAddress);
        if (current > 0n) {
          await tokenAsSigner.transfer(deployerAddress, current);
        }

        if (BigInt(balance) > 0n) {
          await tokenAsDeployer.transfer(signerAddress, BigInt(balance));
        }
      }

      this.logger.info(
        { balances, signer: await signerWallet.getAddress() },
        'ERC20 inventory signer balances configured',
      );
      return;
    }

    for (const [chain, balance] of Object.entries(balances)) {
      const provider = localProviders.get(chain);
      if (balance === undefined) {
        continue;
      }
      if (!provider) {
        throw new Error(
          `Missing local provider for inventory signer chain ${chain}`,
        );
      }

      await provider.send('anvil_setBalance', [
        signerAddress,
        toHex(BigInt(balance)),
      ]);
    }

    this.logger.info(
      { balances, signer: signerAddress },
      'Inventory signer balances configured',
    );
  }

  private buildMockExplorerConfig(): MockExplorerConfig {
    const monitoredRoute = this.getMonitoredRouteAddresses();
    const userTransfers: ExplorerMessage[] = [...this.mockTransfers];

    for (let i = 0; i < this.pendingTransfers.length; i++) {
      const params = this.pendingTransfers[i];
      const warpRecipient = params.warpRecipient ?? monitoredRoute[params.to];

      const mockTransfer: ExplorerMessage = {
        msg_id: `0x${(1000 + i).toString(16).padStart(64, '0')}`,
        origin_domain_id: DOMAIN_IDS[params.from],
        destination_domain_id: DOMAIN_IDS[params.to],
        sender: monitoredRoute[params.from],
        recipient: monitoredRoute[params.to],
        origin_tx_hash: `0x${(2000 + i).toString(16).padStart(64, '0')}`,
        origin_tx_sender: `0x${(3000 + i).toString(16).padStart(40, '0')}`,
        origin_tx_recipient: monitoredRoute[params.from],
        is_delivered: false,
        message_body: encodeWarpRouteMessageBody(warpRecipient, params.amount),
        send_occurred_at: null,
      };

      userTransfers.push(mockTransfer);

      this.logger.debug(
        {
          transfer: {
            from: params.from,
            to: params.to,
            origin: mockTransfer.origin_domain_id,
            destination: mockTransfer.destination_domain_id,
            amount: params.amount.toString(),
          },
        },
        'Created mock pending transfer',
      );
    }

    return {
      userTransfers,
      rebalanceActions: [],
    };
  }

  private getMonitoredRouteAddresses(): Record<TestChain, string> {
    if (this.erc20InventoryConfig) {
      return this.erc20InventoryConfig.erc20DeployedAddresses.monitoredRoute;
    }

    if (this.inventoryConfig) {
      return this.inventoryConfig.nativeDeployedAddresses.monitoredRoute;
    }

    const deployedAddresses =
      this.deploymentManager.getContext().deployedAddresses;
    if (!('tokens' in deployedAddresses)) {
      throw new Error('Expected ERC20 deployed addresses with tokens field');
    }
    return deployedAddresses.monitoredRoute;
  }

  private async getInventoryMultiProvider(
    localProviders: Map<string, ReturnType<MultiProvider['getProvider']>>,
  ): Promise<MultiProvider> {
    const inventoryMultiProvider = this.multiProvider.extendChainMetadata({});
    const config = this.inventoryConfig ?? this.erc20InventoryConfig;
    assert(
      config,
      'getInventoryMultiProvider requires inventoryConfig or erc20InventoryConfig',
    );
    const inventoryWallet = new LocalAccountEvmSigner(
      ensure0x(config.inventorySignerKey),
    );

    for (const chain of TEST_CHAINS) {
      const provider = localProviders.get(chain);
      if (!provider) {
        throw new Error(
          `Missing local provider for inventory chain ${chain} in getInventoryMultiProvider`,
        );
      }
      inventoryMultiProvider.setSigner(
        chain,
        inventoryWallet.connect(provider as any),
      );
    }

    this.logger.info(
      'Created inventory MultiProvider with test inventory signer',
    );

    return inventoryMultiProvider;
  }

  private async getWorkingMultiProvider(): Promise<MultiProvider> {
    if (this.executionMode === 'propose') {
      return this.multiProvider;
    }

    const ctx = this.deploymentManager.getContext();
    const rebalancerMultiProvider = this.multiProvider.extendChainMetadata({});

    const wallet = new LocalAccountViemSigner(ensure0x(ANVIL_TEST_PRIVATE_KEY));
    for (const chain of TEST_CHAINS) {
      const provider = ctx.providers.get(chain);
      if (provider) {
        rebalancerMultiProvider.setSigner(chain, wallet.connect(provider as any));
      }
    }

    this.logger.info(
      'Created MultiProvider with deployer as rebalancer for execute mode',
    );

    return rebalancerMultiProvider;
  }
}

export class TestRebalancer {
  static builder(
    deploymentManager: BaseLocalDeploymentManager<
      DeployedAddresses | NativeDeployedAddresses
    >,
    multiProvider: MultiProvider,
  ): TestRebalancerBuilder {
    return new TestRebalancerBuilder(deploymentManager, multiProvider);
  }
}

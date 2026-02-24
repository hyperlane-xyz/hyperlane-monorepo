import { BigNumber, ethers } from 'ethers';
import { type Logger, pino } from 'pino';

import {
  HyperlaneCore,
  MultiProtocolProvider,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../../config/RebalancerConfig.js';
import {
  type StrategyConfig,
  getStrategyChainNames,
} from '../../config/types.js';
import {
  RebalancerOrchestrator,
  type RebalancerOrchestratorDeps,
} from '../../core/RebalancerOrchestrator.js';
import { RebalancerContextFactory } from '../../factories/RebalancerContextFactory.js';
import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { IStrategy } from '../../interfaces/IStrategy.js';
import type { Monitor } from '../../monitor/Monitor.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { ExplorerMessage } from '../../utils/ExplorerClient.js';
import {
  ANVIL_TEST_PRIVATE_KEY,
  BALANCE_PRESETS,
  DOMAIN_IDS,
  type DeployedAddresses,
  MONITORED_ROUTE_ID,
  TEST_CHAINS,
  type TestChain,
  buildWarpRouteConfig,
} from '../fixtures/routes.js';

import { setupCollateralBalances } from './BridgeSetup.js';
import { ForkIndexer } from './ForkIndexer.js';
import {
  type LocalDeploymentContext,
  LocalDeploymentManager,
} from './LocalDeploymentManager.js';
import {
  MockExplorerClient,
  type MockExplorerConfig,
} from './MockExplorerClient.js';

function encodeWarpRouteMessageBody(
  recipient: string,
  amount: BigNumber,
): string {
  const recipientBytes32 = addressToBytes32(recipient);
  const amountHex = ethers.utils.hexZeroPad(amount.toHexString(), 32);
  return recipientBytes32 + amountHex.slice(2);
}

export interface PendingTransferParams {
  from: TestChain;
  to: TestChain;
  amount: BigNumber;
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
  createMonitor(checkFrequency: number): Monitor;
  getConfirmedBlockTags(): Promise<ConfirmedBlockTags>;
}

type BalancePreset = keyof typeof BALANCE_PRESETS;
type BalanceConfig = BalancePreset | Record<string, BigNumber>;
type ExecutionMode = 'propose' | 'execute';

export class TestRebalancerBuilder {
  private strategyConfig: StrategyConfig[] | undefined;
  private balanceConfig: BalanceConfig = 'BALANCED';
  private pendingTransfers: PendingTransferParams[] = [];
  private mockTransfers: ExplorerMessage[] = [];
  private executionMode: ExecutionMode = 'propose';
  private readonly logger: Logger;

  constructor(
    private readonly deploymentManager: LocalDeploymentManager,
    private readonly multiProvider: MultiProvider,
  ) {
    this.logger = pino({ level: 'debug' }).child({ module: 'TestRebalancer' });
  }

  withStrategy(config: StrategyConfig[]): this {
    this.strategyConfig = config;
    return this;
  }

  withBalances(preset: BalancePreset | Record<string, BigNumber>): this {
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
      } catch (error) {
        this.logger.warn(
          { chain, error: (error as Error).message },
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

    await this.setupBalances();

    const ctx = this.deploymentManager.getContext();
    const { providers: localProviders }: LocalDeploymentContext = ctx;
    const deployedAddresses: DeployedAddresses = ctx.deployedAddresses;

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: deployedAddresses.chains[chain].mailbox,
        interchainSecurityModule: deployedAddresses.chains[chain].ism,
      };
    }
    const hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      this.multiProvider,
    );

    const deployerWallet = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY);
    const rebalancerAddresses = [deployerWallet.address];

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

    const rebalancerConfig = new RebalancerConfig(
      MONITORED_ROUTE_ID,
      this.strategyConfig,
    );

    const registry = this.deploymentManager.getRegistry();
    const mpp = MultiProtocolProvider.fromMultiProvider(workingMultiProvider);

    const warpCoreConfig = buildWarpRouteConfig(deployedAddresses);
    const contextFactory = await RebalancerContextFactory.create(
      rebalancerConfig,
      workingMultiProvider,
      undefined,
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

    // In execute mode, create actual Rebalancers to enable intent creation and execution
    const rebalancers =
      this.executionMode === 'execute'
        ? (await contextFactory.createRebalancers(tracker)).rebalancers
        : [];

    const orchestratorDeps: RebalancerOrchestratorDeps = {
      strategy,
      rebalancers,
      actionTracker: tracker,
      inflightContextAdapter: adapter,
      rebalancerConfig,
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
      createMonitor: (checkFrequency: number) =>
        contextFactory.createMonitor(checkFrequency),
      getConfirmedBlockTags: () => this.computeConfirmedBlockTags(),
    };
  }

  private getBalanceChains(): string[] {
    if (typeof this.balanceConfig === 'string') {
      return Object.keys(BALANCE_PRESETS[this.balanceConfig]);
    }
    return Object.keys(this.balanceConfig);
  }

  private getBalances(): Record<string, BigNumber> {
    if (typeof this.balanceConfig === 'string') {
      const preset = BALANCE_PRESETS[this.balanceConfig];
      return Object.fromEntries(
        Object.entries(preset).map(([chain, value]) => [
          chain,
          BigNumber.from(value),
        ]),
      ) as Record<string, BigNumber>;
    }
    return this.balanceConfig;
  }

  private async setupBalances(): Promise<void> {
    const balances = this.getBalances();
    const ctx = this.deploymentManager.getContext();
    const { providers: localProviders } = ctx;
    const deployedAddresses: DeployedAddresses = ctx.deployedAddresses;

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

  private buildMockExplorerConfig(): MockExplorerConfig {
    const { deployedAddresses }: LocalDeploymentContext =
      this.deploymentManager.getContext();
    const userTransfers: ExplorerMessage[] = [...this.mockTransfers];

    for (let i = 0; i < this.pendingTransfers.length; i++) {
      const params = this.pendingTransfers[i];
      const warpRecipient =
        params.warpRecipient ?? deployedAddresses.monitoredRoute[params.to];

      const mockTransfer: ExplorerMessage = {
        msg_id: `0x${(1000 + i).toString(16).padStart(64, '0')}`,
        origin_domain_id: DOMAIN_IDS[params.from],
        destination_domain_id: DOMAIN_IDS[params.to],
        sender: deployedAddresses.monitoredRoute[params.from],
        recipient: deployedAddresses.monitoredRoute[params.to],
        origin_tx_hash: `0x${(2000 + i).toString(16).padStart(64, '0')}`,
        origin_tx_sender: `0x${(3000 + i).toString(16).padStart(40, '0')}`,
        origin_tx_recipient: deployedAddresses.monitoredRoute[params.from],
        is_delivered: false,
        message_body: encodeWarpRouteMessageBody(warpRecipient, params.amount),
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

  private async getWorkingMultiProvider(): Promise<MultiProvider> {
    if (this.executionMode === 'propose') {
      return this.multiProvider;
    }

    const ctx = this.deploymentManager.getContext();
    const rebalancerMultiProvider = this.multiProvider.extendChainMetadata({});

    const wallet = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY);
    for (const chain of TEST_CHAINS) {
      const provider = ctx.providers.get(chain);
      if (provider) {
        rebalancerMultiProvider.setSigner(chain, wallet.connect(provider));
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
    deploymentManager: LocalDeploymentManager,
    multiProvider: MultiProvider,
  ): TestRebalancerBuilder {
    return new TestRebalancerBuilder(deploymentManager, multiProvider);
  }
}

import { BigNumber, ethers } from 'ethers';
import { type Logger, pino } from 'pino';

import { MultiProtocolProvider, type MultiProvider } from '@hyperlane-xyz/sdk';
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
import type { IStrategy } from '../../interfaces/IStrategy.js';
import type { Monitor } from '../../monitor/Monitor.js';
import type { IActionTracker } from '../../tracking/index.js';
import type { ExplorerMessage } from '../../utils/ExplorerClient.js';
import {
  BALANCE_PRESETS,
  DOMAIN_IDS,
  TEST_CHAINS,
  TEST_WARP_ROUTE_CONFIG,
  type TestChain,
  USDC_ADDRESSES,
  USDC_INCENTIV_WARP_ROUTE,
  USDC_SUPERSEED_WARP_ROUTE,
} from '../fixtures/routes.js';

import {
  configureAllowedBridges,
  setupCollateralBalances,
} from './BridgeSetup.js';
import type { ForkManager } from './ForkManager.js';
import { MockExplorerClient } from './MockExplorerClient.js';
import {
  getRebalancerAddress,
  impersonateRebalancer,
} from './TransferHelper.js';

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
  multiProvider: MultiProvider;
  rebalancerConfig: RebalancerConfig;
  contextFactory: RebalancerContextFactory;
  createMonitor(checkFrequency: number): Monitor;
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
    private readonly forkManager: ForkManager,
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
    const mockExplorer = this.buildMockExplorer();
    const workingMultiProvider = await this.getWorkingMultiProvider();

    const rebalancerConfig = new RebalancerConfig(
      USDC_INCENTIV_WARP_ROUTE.id,
      this.strategyConfig,
    );

    const forkedRegistry = this.forkManager.getRegistry();
    const mpp = MultiProtocolProvider.fromMultiProvider(workingMultiProvider);

    const contextFactory = await RebalancerContextFactory.create(
      rebalancerConfig,
      workingMultiProvider,
      mpp,
      forkedRegistry,
      this.logger,
      TEST_WARP_ROUTE_CONFIG,
    );

    const strategy = await contextFactory.createStrategy();
    const { tracker, adapter } =
      await contextFactory.createActionTracker(mockExplorer);

    await tracker.initialize();
    this.logger.info('ActionTracker initialized with mock explorer');

    // In execute mode, create an actual Rebalancer to enable intent creation and execution
    const rebalancer =
      this.executionMode === 'execute'
        ? contextFactory.createRebalancer()
        : undefined;

    const orchestratorDeps: RebalancerOrchestratorDeps = {
      strategy,
      rebalancer,
      actionTracker: tracker,
      inflightContextAdapter: adapter,
      multiProvider: workingMultiProvider,
      rebalancerConfig,
      logger: this.logger,
    };
    const orchestrator = new RebalancerOrchestrator(orchestratorDeps);

    return {
      orchestrator,
      strategy,
      tracker,
      mockExplorer,
      multiProvider: workingMultiProvider,
      rebalancerConfig,
      contextFactory,
      createMonitor: (checkFrequency: number) =>
        contextFactory.createMonitor(checkFrequency),
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
    const forkedProviders = this.forkManager.getContext().providers;

    await setupCollateralBalances(
      forkedProviders,
      balances,
      USDC_INCENTIV_WARP_ROUTE.routers,
      USDC_ADDRESSES,
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

  private buildMockExplorer(): MockExplorerClient {
    const userTransfers: ExplorerMessage[] = [...this.mockTransfers];

    for (let i = 0; i < this.pendingTransfers.length; i++) {
      const params = this.pendingTransfers[i];
      const warpRecipient =
        params.warpRecipient ?? USDC_INCENTIV_WARP_ROUTE.routers[params.to];

      const mockTransfer: ExplorerMessage = {
        msg_id: `0x${(1000 + i).toString(16).padStart(64, '0')}`,
        origin_domain_id: DOMAIN_IDS[params.from],
        destination_domain_id: DOMAIN_IDS[params.to],
        sender: USDC_INCENTIV_WARP_ROUTE.routers[params.from],
        recipient: USDC_INCENTIV_WARP_ROUTE.routers[params.to],
        origin_tx_hash: `0x${(2000 + i).toString(16).padStart(64, '0')}`,
        origin_tx_sender: `0x${(3000 + i).toString(16).padStart(40, '0')}`,
        origin_tx_recipient: USDC_INCENTIV_WARP_ROUTE.routers[params.from],
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

    return new MockExplorerClient({
      userTransfers,
      rebalanceActions: [],
    });
  }

  private async getWorkingMultiProvider(): Promise<MultiProvider> {
    if (this.executionMode === 'propose') {
      return this.multiProvider;
    }

    const forkedProviders = this.forkManager.getContext().providers;
    const ethProvider = forkedProviders.get('ethereum');
    if (!ethProvider) {
      throw new Error('Ethereum provider not found for execute mode');
    }

    const rebalancerAddress = await getRebalancerAddress(
      ethProvider,
      USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
    );

    this.logger.info(
      { rebalancerAddress },
      'Found rebalancer address from bridge',
    );

    await this.configureAllowedBridgesForExecuteMode(ethProvider);

    const { signer: rebalancerSigner } = await impersonateRebalancer(
      ethProvider,
      USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
    );

    const rebalancerMultiProvider = this.multiProvider.extendChainMetadata({});
    for (const chain of TEST_CHAINS) {
      const provider = forkedProviders.get(chain);
      if (provider && chain === 'ethereum') {
        rebalancerMultiProvider.setSigner(chain, rebalancerSigner);
      }
    }

    this.logger.info(
      'Impersonated rebalancer and created MultiProvider for execute mode',
    );

    return rebalancerMultiProvider;
  }

  private async configureAllowedBridgesForExecuteMode(
    ethProvider: ethers.providers.JsonRpcProvider,
  ): Promise<void> {
    const bridgeConfigs = TEST_CHAINS.filter(
      (chain) => chain !== 'ethereum',
    ).map((chain) => ({
      monitoredRouterAddress: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
      bridgeAddress: USDC_SUPERSEED_WARP_ROUTE.routers.ethereum,
      destinationDomain: DOMAIN_IDS[chain],
    }));

    await configureAllowedBridges(ethProvider, bridgeConfigs);

    this.logger.info(
      'Configured allowed bridges on monitored router for execute mode',
    );
  }
}

export class TestRebalancer {
  static builder(
    forkManager: ForkManager,
    multiProvider: MultiProvider,
  ): TestRebalancerBuilder {
    return new TestRebalancerBuilder(forkManager, multiProvider);
  }
}

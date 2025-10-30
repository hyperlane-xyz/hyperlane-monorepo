import { Logger } from 'pino';

import { Token } from '@hyperlane-xyz/sdk';
import { assert, createServiceLogger, toWei } from '@hyperlane-xyz/utils';

import type { WriteCommandContext } from '../context/types.js';
import { ENV } from '../utils/env.js';
import { VERSION } from '../version.js';

import { RebalancerConfig } from './config/RebalancerConfig.js';
import { RebalancerContextFactory } from './factories/RebalancerContextFactory.js';
import {
  MonitorEvent,
  MonitorEventType,
  MonitorPollingError,
  MonitorStartError,
} from './interfaces/IMonitor.js';
import type { IRebalancer } from './interfaces/IRebalancer.js';
import type { IStrategy } from './interfaces/IStrategy.js';
import { Metrics } from './metrics/Metrics.js';
import { Monitor } from './monitor/Monitor.js';
import { getRawBalances } from './utils/balanceUtils.js';

interface SharedRebalanceArgs {
  config: string;
  checkFrequency: number;
  withMetrics: boolean;
  monitorOnly: boolean;
  manual?: boolean;
}

interface ManualRebalanceArgs {
  origin: string;
  destination: string;
  amount: string;
}

type RebalancerCliArgs = SharedRebalanceArgs & Partial<ManualRebalanceArgs>;

export class RebalancerRunner {
  private isExiting = false;
  private logger: Logger;

  private constructor(
    private readonly contextFactory: RebalancerContextFactory,
    private readonly rebalancerConfig: RebalancerConfig,
    private readonly monitor: Monitor,
    private readonly strategy: IStrategy,
    private readonly rebalancer: IRebalancer | undefined,
    private readonly metrics: Metrics | undefined,
    private readonly manualArgs: ManualRebalanceArgs | undefined,
    logger: Logger,
  ) {
    this.logger = logger.child({ class: RebalancerRunner.name });
  }

  private static validateManualArgs(
    args: RebalancerCliArgs,
  ): ManualRebalanceArgs {
    assert(
      args.origin && args.destination && args.amount,
      'Origin, destination, and amount are required for a manual run',
    );

    // Validate amount is a valid number string and greater than 0
    const amountNum = Number(args.amount);
    assert(!isNaN(amountNum), 'Amount must be a valid number');
    assert(amountNum > 0, 'Amount must be greater than 0');

    return {
      origin: args.origin,
      destination: args.destination,
      amount: args.amount,
    };
  }

  public static async create(
    args: RebalancerCliArgs,
    context: WriteCommandContext,
  ): Promise<RebalancerRunner> {
    const { config, checkFrequency, withMetrics, monitorOnly, manual } = args;

    const logger = await createServiceLogger({
      service: 'rebalancer',
      version: VERSION || 'unknown',
    });

    if (manual && monitorOnly) {
      throw new Error(
        'Manual mode is not compatible with monitorOnly. Please disable monitorOnly in your config or via the CLI.',
      );
    }

    let manualArgs: ManualRebalanceArgs | undefined;
    if (manual) {
      manualArgs = RebalancerRunner.validateManualArgs(args);
    }

    // Load rebalancer config from disk
    const rebalancerConfig = RebalancerConfig.load(config);
    logger.info('✅ Loaded rebalancer config');

    // Instantiate the factory used to create the different rebalancer components
    const contextFactory = await RebalancerContextFactory.create(
      rebalancerConfig,
      context,
      logger,
    );

    // Instantiates the monitor that will observe the warp route
    const monitor = contextFactory.createMonitor(checkFrequency);

    // Instantiates the metrics that will publish stats from the monitored data
    const metrics = withMetrics
      ? await contextFactory.createMetrics(ENV.COINGECKO_API_KEY)
      : undefined;

    // Instantiates the strategy that will compute how rebalance routes should be performed
    const strategy = await contextFactory.createStrategy(metrics);

    // Instantiates the rebalancer in charge of executing the rebalancing transactions
    const rebalancer = !monitorOnly
      ? contextFactory.createRebalancer(metrics)
      : undefined;

    if (monitorOnly) {
      logger.warn(
        'Running in monitorOnly mode: no transactions will be executed.',
      );
    }

    if (withMetrics) {
      logger.warn(
        'Metrics collection has been enabled and will be gathered during execution',
      );
    }

    return new RebalancerRunner(
      contextFactory,
      rebalancerConfig,
      monitor,
      strategy,
      rebalancer,
      metrics,
      manualArgs,
      logger,
    );
  }

  public async run(): Promise<void> {
    if (this.manualArgs) {
      await this.runManual();
    } else {
      await this.runDaemon();
    }
  }

  private async runManual(): Promise<void> {
    assert(this.manualArgs, 'Manual arguments are not defined for manual run');
    assert(this.rebalancer, 'Rebalancer should be defined for a manual run.');
    const { origin, destination, amount } = this.manualArgs;

    this.logger.warn(
      `Manual rebalance strategy selected. Origin: ${origin}, Destination: ${destination}, Amount: ${amount}`,
    );

    const warpCore = this.contextFactory.getWarpCore();
    const originToken = warpCore.tokens.find(
      (t: Token) => t.chainName === origin,
    );

    if (!originToken) {
      this.logger.error(`❌ Origin token not found for chain ${origin}`);
      throw new Error(`Origin token not found for chain ${origin}`);
    }

    try {
      await this.rebalancer.rebalance([
        {
          origin,
          destination,
          amount: BigInt(toWei(amount, originToken.decimals)),
        },
      ]);
      this.logger.info(
        `✅ Manual rebalance from ${origin} to ${destination} for amount ${amount} submitted successfully.`,
      );
      return;
    } catch (e: any) {
      this.logger.error(
        { err: e },
        `❌ Manual rebalance from ${origin} to ${destination} failed.`,
      );
      throw e;
    }
  }

  private async runDaemon(): Promise<void> {
    // Setup monitor event listeners before starting it.
    // These handlers deal with events and errors occurring *after* the monitor has successfully started.
    this.monitor
      .on(MonitorEventType.TokenInfo, this.onTokenInfo.bind(this))
      .on(MonitorEventType.Error, this.onMonitorError.bind(this))
      .on(MonitorEventType.Start, this.onMonitorStart.bind(this));

    // Set up signal handlers for graceful shutdown.
    process.on('SIGINT', () => this.gracefulShutdown());
    process.on('SIGTERM', () => this.gracefulShutdown());

    try {
      await this.monitor.start();
    } catch (e: any) {
      this.logger.error({ err: e }, 'Rebalancer startup error:');
      throw e;
    }
  }

  private async onTokenInfo(event: MonitorEvent): Promise<void> {
    if (this.metrics) {
      await Promise.all(
        event.tokensInfo.map((tokenInfo) =>
          this.metrics!.processToken(tokenInfo),
        ),
      );
    }

    const rawBalances = getRawBalances(
      Object.keys(this.rebalancerConfig.strategyConfig.chains),
      event,
      this.logger,
    );

    const rebalancingRoutes = this.strategy.getRebalancingRoutes(rawBalances);

    this.rebalancer
      ?.rebalance(rebalancingRoutes)
      .then(() => {
        // On successful rebalance attempt by monitor
        this.metrics?.recordRebalancerSuccess();
        this.logger.info('Rebalancer completed a cycle successfully.');
      })
      .catch((e: any) => {
        this.metrics?.recordRebalancerFailure();
        // This is an operational error, log it but don't stop the monitor.
        this.logger.error({ err: e }, 'Error while rebalancing:');
      });
  }

  private onMonitorError(e: Error): void {
    if (e instanceof MonitorPollingError) {
      this.logger.error(e.message);
      this.metrics?.recordPollingError();
    } else if (e instanceof MonitorStartError) {
      this.logger.error(e.message);
      throw e;
    } else {
      this.logger.error(
        { err: e },
        'An unexpected error occurred in the monitor:',
      );
    }
  }

  private onMonitorStart(): void {
    this.logger.info('Rebalancer started successfully 🚀');
  }

  public stop(): Promise<void> {
    return this.monitor.stop();
  }

  public async gracefulShutdown(): Promise<void> {
    if (this.isExiting) {
      return;
    }
    this.isExiting = true;

    this.logger.info('Gracefully shutting down rebalancer...');
    await this.stop();
    // Unregister listeners to prevent them from being called again during shutdown
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    this.logger.info('Rebalancer shutdown complete.');
    process.exit(0);
  }
}

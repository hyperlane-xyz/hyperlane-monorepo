import { format } from 'util';

import { Token } from '@hyperlane-xyz/sdk';
import { assert, toWei } from '@hyperlane-xyz/utils';

import type { WriteCommandContext } from '../context/types.js';
import { errorRed, logGreen, warnYellow } from '../logger.js';

import { RebalancerConfig } from './config/RebalancerConfig.js';
import { RebalancerContextFactory } from './factories/RebalancerContextFactory.js';
import type { IRebalancer } from './interfaces/IRebalancer.js';
import type { IStrategy } from './interfaces/IStrategy.js';
import { Metrics } from './metrics/Metrics.js';
import {
  Monitor,
  MonitorEventType,
  MonitorPollingError,
  MonitorStartError,
} from './monitor/Monitor.js';
import { getRawBalances } from './utils/getRawBalances.js';
import { rebalancerLogger } from './utils/logger.js';

interface RebalancerRunnerArgs {
  config: string;
  checkFrequency: number;
  withMetrics: boolean;
  monitorOnly: boolean;
  manual?: boolean;
  origin?: string;
  destination?: string;
  amount?: string;
}

export class RebalancerRunner {
  private readonly monitor: Monitor;
  private readonly strategy: IStrategy;
  private readonly rebalancer: IRebalancer | undefined;
  private readonly metrics: Metrics | undefined;
  private readonly rebalancerConfig: RebalancerConfig;
  private readonly contextFactory: RebalancerContextFactory;

  private constructor(
    private readonly args: RebalancerRunnerArgs,
    contextFactory: RebalancerContextFactory,
    rebalancerConfig: RebalancerConfig,
    monitor: Monitor,
    strategy: IStrategy,
    rebalancer: IRebalancer | undefined,
    metrics: Metrics | undefined,
  ) {
    this.args = args;
    this.contextFactory = contextFactory;
    this.rebalancerConfig = rebalancerConfig;
    this.monitor = monitor;
    this.strategy = strategy;
    this.rebalancer = rebalancer;
    this.metrics = metrics;
  }

  public static async create(
    args: RebalancerRunnerArgs,
    context: WriteCommandContext,
  ): Promise<RebalancerRunner> {
    const { config, checkFrequency, withMetrics, monitorOnly } = args;
    // Load rebalancer config from disk
    const rebalancerConfig = RebalancerConfig.load(config, {
      checkFrequency,
      withMetrics,
      monitorOnly,
    });
    logGreen('✅ Loaded rebalancer config');

    // Instantiate the factory used to create the different rebalancer components
    const contextFactory = await RebalancerContextFactory.create(
      rebalancerConfig,
      context,
    );

    // Instantiates the monitor that will observe the warp route
    const monitor = contextFactory.createMonitor();

    // Instantiates the metrics that will publish stats from the monitored data
    const metrics = withMetrics
      ? await contextFactory.createMetrics()
      : undefined;

    // Instantiates the strategy that will compute how rebalance routes should be performed
    const strategy = await contextFactory.createStrategy(metrics);

    // Instantiates the rebalancer in charge of executing the rebalancing transactions
    const rebalancer = !rebalancerConfig.monitorOnly
      ? contextFactory.createRebalancer(metrics)
      : undefined;

    if (rebalancerConfig.monitorOnly) {
      warnYellow(
        'Running in monitorOnly mode: no transactions will be executed.',
      );
    }

    if (withMetrics) {
      warnYellow(
        'Metrics collection has been enabled and will be gathered during execution',
      );
      // Initialize execution status metrics, if metrics are enabled
      metrics?.initializeRebalancerMetrics();
    }

    return new RebalancerRunner(
      args,
      contextFactory,
      rebalancerConfig,
      monitor,
      strategy,
      rebalancer,
      metrics,
    );
  }

  public async run(): Promise<void> {
    try {
      if (this.args.manual) {
        await this.runManual();
      } else {
        await this.runDaemon();
      }
    } catch (e) {
      rebalancerLogger.error(e, 'Rebalancer runner failed');
      errorRed('Rebalancer startup error:', format(e));
      process.exit(1);
    }
  }

  private async runManual(): Promise<void> {
    const { origin, destination, amount } = this.args;
    assert(origin, '--origin is required');
    assert(destination, '--destination is required');
    assert(amount, '--amount is required');

    warnYellow(
      `Manual rebalance strategy selected. Origin: ${origin}, Destination: ${destination}, Amount: ${amount}`,
    );

    const warpCore = this.contextFactory.getWarpCore();
    const rebalancer = this.contextFactory.createRebalancer();
    const originToken = warpCore.tokens.find(
      (t: Token) => t.chainName === origin,
    );

    try {
      await rebalancer.rebalance([
        {
          origin,
          destination,
          amount: BigInt(toWei(amount, originToken!.decimals)),
        },
      ]);
      logGreen(
        `✅ Manual rebalance from ${origin} to ${destination} for amount ${amount} submitted successfully.`,
      );
      process.exit(0);
    } catch (e: any) {
      errorRed(`❌ Manual rebalance from ${origin} to ${destination} failed.`);
      errorRed(format(e));
      process.exit(1);
    }
  }

  private async runDaemon(): Promise<void> {
    // Setup monitor event listeners before starting it.
    // These handlers deal with events and errors occurring *after* the monitor has successfully started.
    this.monitor
      .on(MonitorEventType.TokenInfo, this.onTokenInfo.bind(this))
      .on(MonitorEventType.Error, this.onMonitorError.bind(this))
      .on(MonitorEventType.Start, this.onMonitorStart.bind(this));

    try {
      // Finally, starts the monitor to begin polling balances.
      await this.monitor.start();
    } catch (e: any) {
      if (e instanceof MonitorStartError) {
        errorRed('Rebalancer startup error:', format(e));
      } else {
        errorRed('Unexpected error:', format(e));
      }
      process.exit(1);
    }
  }

  private onTokenInfo(event: any): void {
    if (this.metrics) {
      for (const tokenInfo of event.tokensInfo) {
        this.metrics.processToken(tokenInfo).catch((e) => {
          errorRed(
            `Error building metrics for ${tokenInfo.token.addressOrDenom}: ${e.message}`,
          );
        });
      }
    }

    const rawBalances = getRawBalances(
      Object.keys(this.rebalancerConfig.chains),
      event,
    );

    const rebalancingRoutes = this.strategy.getRebalancingRoutes(rawBalances);

    this.rebalancer
      ?.rebalance(rebalancingRoutes)
      .then(() => {
        // On successful rebalance attempt by monitor
        this.metrics?.recordRebalancerSuccess();
        logGreen('Rebalancer completed a cycle successfully.');
      })
      .catch((e: any) => {
        this.metrics?.recordRebalancerFailure();
        // This is an operational error, log it but don't stop the monitor.
        errorRed('Error while rebalancing:', format(e));
      });
  }

  private onMonitorError(e: Error): void {
    if (e instanceof MonitorPollingError) {
      errorRed(e.message);
      this.metrics?.recordPollingError();
    } else {
      // This will catch `MonitorStartError` and generic errors
      throw e;
    }
  }

  private onMonitorStart(): void {
    logGreen('Rebalancer started successfully 🚀');
  }
}

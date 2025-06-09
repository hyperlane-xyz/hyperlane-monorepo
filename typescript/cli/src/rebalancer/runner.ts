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
  private monitor: Monitor | undefined;
  private strategy: IStrategy | undefined;
  private rebalancer: IRebalancer | undefined;
  private metrics: Metrics | undefined;
  private rebalancerConfig: RebalancerConfig | undefined;
  private contextFactory: RebalancerContextFactory | undefined;

  constructor(
    private readonly args: RebalancerRunnerArgs,
    private readonly context: WriteCommandContext,
  ) {}

  public async run(): Promise<void> {
    try {
      await this.initialize();
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

  private async initialize(): Promise<void> {
    const { config, checkFrequency, withMetrics, monitorOnly } = this.args;
    // Load rebalancer config from disk
    this.rebalancerConfig = RebalancerConfig.load(config, {
      checkFrequency,
      withMetrics,
      monitorOnly,
    });
    logGreen('✅ Loaded rebalancer config');

    // Instantiate the factory used to create the different rebalancer components
    this.contextFactory = await RebalancerContextFactory.create(
      this.rebalancerConfig,
      this.context,
    );

    // Instantiates the monitor that will observe the warp route
    this.monitor = this.contextFactory.createMonitor();

    // Instantiates the metrics that will publish stats from the monitored data
    this.metrics = withMetrics
      ? await this.contextFactory.createMetrics()
      : undefined;

    // Instantiates the strategy that will compute how rebalance routes should be performed
    this.strategy = await this.contextFactory.createStrategy(this.metrics);

    // Instantiates the rebalancer in charge of executing the rebalancing transactions
    this.rebalancer = !this.rebalancerConfig.monitorOnly
      ? this.contextFactory.createRebalancer(this.metrics)
      : undefined;

    if (this.rebalancerConfig.monitorOnly) {
      warnYellow(
        'Running in monitorOnly mode: no transactions will be executed.',
      );
    }

    if (withMetrics) {
      warnYellow(
        'Metrics collection has been enabled and will be gathered during execution',
      );
      // Initialize execution status metrics, if metrics are enabled
      this.metrics?.initializeRebalancerMetrics();
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

    assert(this.contextFactory, 'Context factory not initialized');
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
    assert(this.monitor, 'Monitor not initialized');
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
    assert(this.rebalancerConfig, 'Rebalancer config not initialized');
    assert(this.strategy, 'Strategy not initialized');

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

import { format } from 'util';

import { Token } from '@hyperlane-xyz/sdk';
import { assert, toWei } from '@hyperlane-xyz/utils';

import type { WriteCommandContext } from '../context/types.js';
import { errorRed, logGreen, warnYellow } from '../logger.js';

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
import { getRawBalances } from './utils/getRawBalances.js';

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
  amount: number;
}

type RebalancerCliArgs = SharedRebalanceArgs & Partial<ManualRebalanceArgs>;

export class RebalancerRunner {
  private isExiting = false;
  private constructor(
    private readonly contextFactory: RebalancerContextFactory,
    private readonly rebalancerConfig: RebalancerConfig,
    private readonly monitor: Monitor,
    private readonly strategy: IStrategy,
    private readonly rebalancer: IRebalancer | undefined,
    private readonly metrics: Metrics | undefined,
    private readonly manualArgs: ManualRebalanceArgs | undefined,
  ) {}

  private static validateManualArgs(
    args: RebalancerCliArgs,
  ): ManualRebalanceArgs {
    assert(
      args.origin && args.destination && args.amount,
      'Origin, destination, and amount are required for a manual run',
    );
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

    if (manual && monitorOnly) {
      throw new Error(
        'Manual mode is not compatible with monitorOnly. Please disable monitorOnly in your config or via the CLI.',
      );
    }

    let manualArgs: ManualRebalanceArgs | undefined;
    if (manual) {
      manualArgs = this.validateManualArgs(args);
    }

    // Load rebalancer config from disk
    const rebalancerConfig = RebalancerConfig.load(config);
    logGreen('✅ Loaded rebalancer config');

    // Instantiate the factory used to create the different rebalancer components
    const contextFactory = await RebalancerContextFactory.create(
      rebalancerConfig,
      context,
    );

    // Instantiates the monitor that will observe the warp route
    const monitor = contextFactory.createMonitor(checkFrequency);

    // Instantiates the metrics that will publish stats from the monitored data
    const metrics = withMetrics
      ? await contextFactory.createMetrics()
      : undefined;

    // Instantiates the strategy that will compute how rebalance routes should be performed
    const strategy = await contextFactory.createStrategy(metrics);

    // Instantiates the rebalancer in charge of executing the rebalancing transactions
    const rebalancer = !monitorOnly
      ? contextFactory.createRebalancer()
      : undefined;

    if (monitorOnly) {
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
      contextFactory,
      rebalancerConfig,
      monitor,
      strategy,
      rebalancer,
      metrics,
      manualArgs,
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

    warnYellow(
      `Manual rebalance strategy selected. Origin: ${origin}, Destination: ${destination}, Amount: ${amount}`,
    );

    const warpCore = this.contextFactory.getWarpCore();
    const originToken = warpCore.tokens.find(
      (t: Token) => t.chainName === origin,
    );

    if (!originToken) {
      errorRed(`❌ Origin token not found for chain ${origin}`);
      process.exit(1);
    }

    try {
      await this.rebalancer.rebalance([
        {
          origin,
          destination,
          amount: BigInt(toWei(amount, originToken.decimals)),
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

    // Set up signal handlers for graceful shutdown.
    process.on('SIGINT', () => this.gracefulShutdown());
    process.on('SIGTERM', () => this.gracefulShutdown());

    try {
      await this.monitor.start();
    } catch (e: any) {
      errorRed('Rebalancer startup error:', format(e));
      process.exit(1);
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
    } else if (e instanceof MonitorStartError) {
      errorRed(e.message);
      process.exit(1);
    } else {
      errorRed('An unexpected error occurred in the monitor:', format(e));
    }
  }

  private onMonitorStart(): void {
    logGreen('Rebalancer started successfully 🚀');
  }

  public stop(): Promise<void> {
    return this.monitor.stop();
  }

  public async gracefulShutdown(): Promise<void> {
    if (this.isExiting) return;
    this.isExiting = true;

    logGreen('Gracefully shutting down rebalancer...');
    await this.stop();
    // Unregister listeners to prevent them from being called again during shutdown
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.exit(0);
  }
}

import { format } from 'util';

import { assert, toWei } from '@hyperlane-xyz/utils';

import { WriteCommandContext } from '../context/types.js';
import { errorRed, logGreen, warnYellow } from '../logger.js';

import { RebalancerConfig } from './config/RebalancerConfig.js';
import { RebalancerContextFactory } from './factories/RebalancerContextFactory.js';
import {
  MonitorEventType,
  MonitorPollingError,
  MonitorStartError,
} from './interfaces/IMonitor.js';
import { IRebalancer } from './interfaces/IRebalancer.js';
import { IStrategy } from './interfaces/IStrategy.js';
import { Metrics } from './metrics/Metrics.js';
import { Monitor } from './monitor/Monitor.js';
import { getRawBalances } from './utils/getRawBalances.js';

interface RunRebalancerOptions {
  context: WriteCommandContext;
  configPath: string;
  checkFrequency: number;
  withMetrics: boolean;
  monitorOnly: boolean;
  manual?: boolean;
  origin?: string;
  destination?: string;
  amount?: number;
}

export async function runRebalancer(options: RunRebalancerOptions) {
  const {
    context,
    configPath,
    checkFrequency,
    withMetrics,
    monitorOnly,
    manual,
    origin,
    destination,
    amount,
  } = options;

  let monitor: Monitor;
  let strategy: IStrategy;
  let rebalancer: IRebalancer | undefined;
  let metrics: Metrics | undefined;
  let rebalancerConfig: RebalancerConfig;

  try {
    // Load rebalancer config from disk
    rebalancerConfig = RebalancerConfig.load(configPath, {
      checkFrequency,
      withMetrics,
      monitorOnly,
    });
    logGreen('✅ Loaded rebalancer config');

    // Instantiate the factory used to create the different rebalancer components
    const rebalancerContextFactory = await RebalancerContextFactory.create(
      rebalancerConfig,
      context,
    );

    if (manual) {
      // These values will be enforced when manual is true given the 'implies' option in the builder.
      // This will probably never fail, but allows the type to be inferred as not undefined.
      assert(origin, '--origin is required');
      assert(destination, '--destination is required');
      assert(amount, '--amount is required');

      warnYellow(
        `Manual rebalance strategy selected. Origin: ${origin}, Destination: ${destination}, Amount: ${amount}`,
      );

      const rebalancer = rebalancerContextFactory.createRebalancer();
      const originToken = rebalancerContextFactory.getTokenForChain(origin);

      if (!originToken) {
        errorRed(`Token for origin chain ${origin} not found`);
        process.exit(1);
      }

      try {
        await rebalancer.rebalance([
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
      } catch (e) {
        errorRed(
          `❌ Manual rebalance from ${origin} to ${destination} failed.`,
        );
        errorRed(format(e));
        process.exit(1);
      }
    }

    // Instantiates the monitor that will observe the warp route
    monitor = rebalancerContextFactory.createMonitor();

    // Instantiates the metrics that will publish stats from the monitored data
    metrics = withMetrics
      ? await rebalancerContextFactory.createMetrics()
      : undefined;

    // Instantiates the strategy that will compute how rebalance routes should be performed
    strategy = await rebalancerContextFactory.createStrategy(metrics);

    // Instantiates the rebalancer in charge of executing the rebalancing transactions
    rebalancer = !rebalancerConfig.monitorOnly
      ? rebalancerContextFactory.createRebalancer()
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
  } catch (e) {
    errorRed('Rebalancer startup error:', format(e));
    process.exit(1);
  }

  try {
    // Setup monitor event listeners before starting it.
    // These handlers deal with events and errors occurring *after* the monitor has successfully started.
    monitor
      // Observe balances events and process rebalancing routes
      .on(MonitorEventType.TokenInfo, (event) => {
        if (metrics) {
          for (const tokenInfo of event.tokensInfo) {
            metrics.processToken(tokenInfo).catch((e) => {
              errorRed(
                `Error building metrics for ${tokenInfo.token.addressOrDenom}: ${e.message}`,
              );
            });
          }
        }

        const rawBalances = getRawBalances(
          Object.keys(rebalancerConfig.chains),
          event,
        );

        const rebalancingRoutes = strategy.getRebalancingRoutes(rawBalances);

        rebalancer
          ?.rebalance(rebalancingRoutes)
          .then(() => {
            // On successful rebalance attempt by monitor
            metrics?.recordRebalancerSuccess();
            logGreen('Rebalancer completed a cycle successfully.');
          })
          .catch((e) => {
            metrics?.recordRebalancerFailure();
            // This is an operational error, log it but don't stop the monitor.
            // TODO: this should be a stuctured log
            errorRed('Error while rebalancing:', format(e));
          });
      })
      // Observe monitor errors and exit
      .on(MonitorEventType.Error, (e) => {
        if (e instanceof MonitorPollingError) {
          errorRed(e.message);
          metrics?.recordPollingError();
        } else {
          // This will catch `MonitorStartError` and generic errors
          throw e;
        }
      })
      // Observe monitor start and log success
      .on(MonitorEventType.Start, () => {
        logGreen('Rebalancer started successfully 🚀');
      });

    // Finally, starts the monitor to begin polling balances.
    await monitor.start();
  } catch (e) {
    if (e instanceof MonitorStartError) {
      errorRed('Rebalancer startup error:', format(e));
    } else {
      errorRed('Unexpected error:', format(e));
    }
    process.exit(1);
  }
}

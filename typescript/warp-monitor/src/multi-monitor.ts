import { startMetricsServer } from '@hyperlane-xyz/metrics';
import type { IRegistry } from '@hyperlane-xyz/registry';
import { sleep, tryFn } from '@hyperlane-xyz/utils';

import { metricsRegister } from './metrics.js';
import {
  type WarpMonitorSharedContext,
  type WarpRouteRuntime,
  buildRouteRuntime,
  buildSharedContext,
  resetCycleMetrics,
  runRouteCycle,
} from './monitor.js';
import { getLogger } from './utils.js';

export interface MultiWarpMonitorConfig {
  // Explicit route ids to monitor. When undefined, every route in the
  // registry is monitored.
  warpRouteIds?: string[];
  checkFrequency: number;
  coingeckoApiKey?: string;
  registryUri?: string;
  explorerApiUrl?: string;
  explorerQueryLimit?: number;
  inventoryAddress?: string;
  // Max number of routes processed concurrently within a single cycle.
  concurrency: number;
  // Routes whose shared balance metrics are owned by another workload
  // (e.g. a rebalancer) and should NOT be re-emitted by this monitor.
  skipSharedBalanceRouteIds?: Set<string>;
}

/**
 * A single long-running process that monitors many warp routes. Replaces the
 * per-route StatefulSet fleet: one metrics server, one MultiProtocolProvider,
 * and one price getter shared across every route. Routes are processed with
 * bounded concurrency and isolated per-route error handling so a single bad
 * RPC cannot stall the whole cycle.
 */
export class MultiWarpMonitor {
  private readonly config: MultiWarpMonitorConfig;
  private readonly registry: IRegistry;

  constructor(config: MultiWarpMonitorConfig, registry: IRegistry) {
    this.config = config;
    this.registry = registry;
  }

  async start(): Promise<void> {
    const logger = getLogger();
    const {
      checkFrequency,
      coingeckoApiKey,
      explorerApiUrl,
      explorerQueryLimit,
      inventoryAddress,
      concurrency,
      skipSharedBalanceRouteIds,
    } = this.config;

    startMetricsServer(metricsRegister);
    logger.info(
      { port: process.env['PROMETHEUS_PORT'] ?? '9090' },
      'Metrics server started',
    );

    const shared = await buildSharedContext(this.registry, coingeckoApiKey);

    const warpRouteIds = await this.resolveRouteIds();
    logger.info(
      { routeCount: warpRouteIds.length, concurrency },
      'Resolved warp routes to monitor',
    );

    const runtimes = await this.buildRuntimes(
      shared,
      warpRouteIds,
      explorerApiUrl,
      explorerQueryLimit,
      inventoryAddress,
      skipSharedBalanceRouteIds,
    );

    if (runtimes.length === 0) {
      throw new Error(
        'No warp route runtimes could be built; nothing to monitor',
      );
    }

    logger.info(
      {
        requested: warpRouteIds.length,
        built: runtimes.length,
        skipped: warpRouteIds.length - runtimes.length,
        checkFrequency,
      },
      'Starting centralized warp route monitor',
    );

    for (;;) {
      const cycleStart = Date.now();
      // Reset per-cycle gauges once before running any route so that stale
      // label sets are cleared without wiping other routes mid-cycle.
      resetCycleMetrics();

      await this.runCycle(shared, runtimes, concurrency);

      logger.info(
        { durationMs: Date.now() - cycleStart, routeCount: runtimes.length },
        'Completed warp route monitor cycle',
      );
      await sleep(checkFrequency);
    }
  }

  private async resolveRouteIds(): Promise<string[]> {
    if (this.config.warpRouteIds && this.config.warpRouteIds.length > 0) {
      return [...this.config.warpRouteIds];
    }
    const warpRoutes = await this.registry.getWarpRoutes();
    return Object.keys(warpRoutes).sort();
  }

  private async buildRuntimes(
    shared: WarpMonitorSharedContext,
    warpRouteIds: string[],
    explorerApiUrl: string | undefined,
    explorerQueryLimit: number | undefined,
    inventoryAddress: string | undefined,
    skipSharedBalanceRouteIds: Set<string> | undefined,
  ): Promise<WarpRouteRuntime[]> {
    const logger = getLogger();
    const runtimes: WarpRouteRuntime[] = [];

    for (const warpRouteId of warpRouteIds) {
      try {
        const runtime = await buildRouteRuntime(this.registry, shared, {
          warpRouteId,
          explorerApiUrl,
          explorerQueryLimit,
          inventoryAddress,
          skipSharedBalanceMetrics:
            skipSharedBalanceRouteIds?.has(warpRouteId) ?? false,
        });
        runtimes.push(runtime);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { warpRouteId, error: message },
          'Failed to build runtime for warp route; skipping',
        );
      }
    }

    return runtimes;
  }

  private async runCycle(
    shared: WarpMonitorSharedContext,
    runtimes: WarpRouteRuntime[],
    concurrency: number,
  ): Promise<void> {
    const logger = getLogger();
    const queue = [...runtimes];

    const worker = async (): Promise<void> => {
      for (;;) {
        const runtime = queue.shift();
        if (!runtime) return;
        await tryFn(
          async () => runRouteCycle(shared, runtime),
          `Updating metrics for warp route ${runtime.warpRouteId}`,
          logger,
        );
      }
    };

    const workerCount = Math.max(1, Math.min(concurrency, runtimes.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => worker()),
    );
  }
}

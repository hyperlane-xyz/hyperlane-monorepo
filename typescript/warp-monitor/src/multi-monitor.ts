import { startMetricsServer } from '@hyperlane-xyz/metrics';
import type { IRegistry } from '@hyperlane-xyz/registry';
import { sleep } from '@hyperlane-xyz/utils';

import { metricsRegister } from './metrics.js';
import {
  type RouteRuntime,
  type SharedMonitorContext,
  buildRouteRuntime,
  buildSharedContext,
  resetCycleMetrics,
  runRouteCycle,
} from './monitor.js';
import { getLogger, setLoggerBindings } from './utils.js';

// A single route's cycle is bounded so one unhealthy chain/RPC cannot stall the
// whole fleet's loop. The next cycle will retry it.
const DEFAULT_ROUTE_CYCLE_TIMEOUT_MS = 120_000;

export type MultiWarpMonitorConfig = {
  warpRouteIds: string[];
  checkFrequency: number;
  concurrency: number;
  coingeckoApiKey?: string;
  explorerApiUrl?: string;
  explorerQueryLimit?: number;
  inventoryAddress?: string;
  // Routes whose shared balance metrics are owned by a rebalancer and must not
  // be double-emitted by this monitor.
  skipSharedBalanceWarpRouteIds?: Set<string>;
  routeCycleTimeoutMs?: number;
};

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Route cycle for ${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A single long-running monitor that iterates many warp routes in a
 * bounded-concurrency loop and emits all their metrics into one shared registry
 * (scraped over one metrics server). Replaces the fleet of one-StatefulSet-per-route
 * monitors: one shared MultiProtocolProvider + price getter, dedup of the shared
 * balance metrics already emitted by rebalancers, and per-route isolation so one
 * bad route cannot stall the others.
 */
export class MultiWarpMonitor {
  private readonly config: MultiWarpMonitorConfig;
  private readonly registry: IRegistry;
  private readonly routeCycleTimeoutMs: number;

  constructor(config: MultiWarpMonitorConfig, registry: IRegistry) {
    this.config = config;
    this.registry = registry;
    this.routeCycleTimeoutMs =
      config.routeCycleTimeoutMs ?? DEFAULT_ROUTE_CYCLE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    const logger = getLogger();
    const {
      warpRouteIds,
      checkFrequency,
      concurrency,
      coingeckoApiKey,
      explorerApiUrl,
      explorerQueryLimit,
      inventoryAddress,
      skipSharedBalanceWarpRouteIds,
    } = this.config;

    setLoggerBindings({ warp_route: 'centralized' });

    startMetricsServer(metricsRegister);
    logger.info(
      { port: process.env['PROMETHEUS_PORT'] ?? '9090' },
      'Metrics server started',
    );

    const ctx = await buildSharedContext(this.registry, coingeckoApiKey);

    // Build each route's runtime up front. A route that fails to resolve (bad
    // config, missing registry entry) is logged and skipped rather than
    // aborting the whole monitor.
    const routes: RouteRuntime[] = [];
    for (const warpRouteId of warpRouteIds) {
      try {
        const route = await buildRouteRuntime(ctx, this.registry, {
          warpRouteId,
          explorerApiUrl,
          explorerQueryLimit,
          inventoryAddress,
          skipSharedBalanceMetrics:
            skipSharedBalanceWarpRouteIds?.has(warpRouteId) ?? false,
        });
        routes.push(route);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { warpRouteId, error: message },
          'Failed to build route runtime, skipping route',
        );
      }
    }

    logger.info(
      {
        requestedRouteCount: warpRouteIds.length,
        activeRouteCount: routes.length,
        skippedSharedBalanceCount: skipSharedBalanceWarpRouteIds?.size ?? 0,
        concurrency,
        checkFrequency,
        explorerEnabled: !!explorerApiUrl,
        inventoryTrackingEnabled: !!inventoryAddress,
      },
      'Starting centralized warp route monitor',
    );

    if (routes.length === 0) {
      throw new Error('No warp routes could be resolved for monitoring');
    }

    for (;;) {
      // Reset per-cycle gauges ONCE, before any route is processed. These
      // gauges are global across routes, so resetting per-route would wipe
      // sibling routes' freshly-written series.
      resetCycleMetrics();
      await this.runCycle(ctx, routes);
      await sleep(checkFrequency);
    }
  }

  private async runCycle(
    ctx: SharedMonitorContext,
    routes: RouteRuntime[],
  ): Promise<void> {
    const concurrency = Math.max(
      1,
      Math.min(this.config.concurrency, routes.length),
    );

    let index = 0;
    const runNext = async (): Promise<void> => {
      while (index < routes.length) {
        const route = routes[index++];
        await this.runRouteWithIsolation(ctx, route);
      }
    };

    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(runNext());
    }
    await Promise.all(workers);
  }

  private async runRouteWithIsolation(
    ctx: SharedMonitorContext,
    route: RouteRuntime,
  ): Promise<void> {
    const logger = getLogger();
    try {
      await withTimeout(
        runRouteCycle(ctx, route),
        this.routeCycleTimeoutMs,
        route.warpRouteId,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { warpRouteId: route.warpRouteId, error: message },
        'Route cycle failed; continuing with remaining routes',
      );
    }
  }
}

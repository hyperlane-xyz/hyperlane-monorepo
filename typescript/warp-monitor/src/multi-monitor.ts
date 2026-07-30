import { startMetricsServer } from '@hyperlane-xyz/metrics';
import type { IRegistry } from '@hyperlane-xyz/registry';
import { assert, sleep } from '@hyperlane-xyz/utils';

import { metricsRegister } from './metrics.js';
import {
  type RouteRuntime,
  type SharedMonitorContext,
  buildRouteRuntime,
  buildSharedContext,
  runRouteCycle,
} from './monitor.js';
import { getLogger, setLoggerBindings } from './utils.js';

// A single route's cycle is bounded so one unhealthy chain/RPC cannot stall the
// whole fleet's loop. The next cycle will retry it.
const DEFAULT_ROUTE_CYCLE_TIMEOUT_MS = 120_000;

// Building a route runtime performs registry reads (getWarpRoute /
// getWarpDeployConfig). Bound each build so one hung read cannot stall startup
// or the background retry that runs alongside active cycles.
const DEFAULT_ROUTE_RESOLVE_TIMEOUT_MS = 60_000;

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
  routeResolveTimeoutMs?: number;
};

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
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
  private readonly routeResolveTimeoutMs: number;
  // Routes whose previous cycle has not settled yet. Skipped this cycle so a
  // route wedged on a slow RPC does not stack overlapping in-flight work that
  // would land in a later cycle's gauges.
  private readonly inFlight = new Set<string>();
  // Guards against stacking overlapping background resolution passes: retry runs
  // off the cycle loop, so a slow pass must not be started again before it ends.
  private resolving = false;

  constructor(config: MultiWarpMonitorConfig, registry: IRegistry) {
    assert(
      Number.isInteger(config.concurrency) && config.concurrency > 0,
      'concurrency must be a positive integer',
    );
    this.config = config;
    this.registry = registry;
    this.routeCycleTimeoutMs =
      config.routeCycleTimeoutMs ?? DEFAULT_ROUTE_CYCLE_TIMEOUT_MS;
    this.routeResolveTimeoutMs =
      config.routeResolveTimeoutMs ?? DEFAULT_ROUTE_RESOLVE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    const logger = getLogger();
    const { warpRouteIds, checkFrequency, concurrency } = this.config;

    setLoggerBindings({ warp_route: 'centralized' });

    startMetricsServer(metricsRegister);
    logger.info(
      { port: process.env['PROMETHEUS_PORT'] ?? '9090' },
      'Metrics server started',
    );

    const ctx = await buildSharedContext(
      this.registry,
      this.config.coingeckoApiKey,
    );

    // Routes that resolve up front are monitored immediately. Any that fail to
    // build (e.g. a transient registry read) stay in `unresolvedRouteIds` and
    // are retried at the start of every cycle rather than being dropped for the
    // process lifetime.
    const routes: RouteRuntime[] = [];
    const unresolvedRouteIds = [...warpRouteIds];
    await this.resolvePendingRoutes(ctx, routes, unresolvedRouteIds);

    logger.info(
      {
        requestedRouteCount: warpRouteIds.length,
        activeRouteCount: routes.length,
        unresolvedRouteCount: unresolvedRouteIds.length,
        skippedSharedBalanceCount:
          this.config.skipSharedBalanceWarpRouteIds?.size ?? 0,
        concurrency,
        checkFrequency,
        explorerEnabled: !!this.config.explorerApiUrl,
        inventoryTrackingEnabled: !!this.config.inventoryAddress,
      },
      'Starting centralized warp route monitor',
    );

    // Only abort if there is genuinely nothing to monitor and nothing to retry.
    // If some routes are merely unresolved (e.g. a transient registry read), the
    // loop keeps retrying them in the background rather than crashing the process.
    if (routes.length === 0 && unresolvedRouteIds.length === 0) {
      throw new Error('No warp routes could be resolved for monitoring');
    }

    for (;;) {
      // Retry any routes that never resolved so a transient startup failure does
      // not permanently exclude a route. Run it OFF the cycle loop: a hung
      // registry read must not stop already-active routes from refreshing.
      if (unresolvedRouteIds.length > 0 && !this.resolving) {
        this.resolving = true;
        void this.resolvePendingRoutes(ctx, routes, unresolvedRouteIds).finally(
          () => {
            this.resolving = false;
          },
        );
      }
      await this.runCycle(ctx, routes);
      await sleep(checkFrequency);
    }
  }

  // Attempts to build a runtime for each unresolved route id, with bounded
  // concurrency and a per-route timeout so one hung registry read cannot stall
  // the whole pass. Successes are appended to `routes`; failures (including
  // timeouts) are logged and left in `unresolvedRouteIds` for a later attempt.
  private async resolvePendingRoutes(
    ctx: SharedMonitorContext,
    routes: RouteRuntime[],
    unresolvedRouteIds: string[],
  ): Promise<void> {
    const logger = getLogger();
    const pending = [...unresolvedRouteIds];
    const resolved: RouteRuntime[] = [];
    const stillUnresolved: string[] = [];

    const concurrency = Math.max(
      1,
      Math.min(this.config.concurrency, pending.length),
    );

    let index = 0;
    const runNext = async (): Promise<void> => {
      while (index < pending.length) {
        const warpRouteId = pending[index++];
        try {
          const route = await withTimeout(
            buildRouteRuntime(ctx, this.registry, {
              warpRouteId,
              explorerApiUrl: this.config.explorerApiUrl,
              explorerQueryLimit: this.config.explorerQueryLimit,
              inventoryAddress: this.config.inventoryAddress,
              skipSharedBalanceMetrics:
                this.config.skipSharedBalanceWarpRouteIds?.has(warpRouteId) ??
                false,
            }),
            this.routeResolveTimeoutMs,
            `Route resolution for ${warpRouteId}`,
          );
          resolved.push(route);
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(
            { warpRouteId, error: message },
            'Failed to build route runtime, will retry next cycle',
          );
          stillUnresolved.push(warpRouteId);
        }
      }
    };

    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(runNext());
    }
    await Promise.all(workers);

    for (const route of resolved) {
      routes.push(route);
    }
    unresolvedRouteIds.length = 0;
    unresolvedRouteIds.push(...stillUnresolved);
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

    if (this.inFlight.has(route.warpRouteId)) {
      logger.warn(
        { warpRouteId: route.warpRouteId },
        'Previous route cycle still in flight; skipping this cycle',
      );
      return;
    }

    this.inFlight.add(route.warpRouteId);
    const work = runRouteCycle(ctx, route);
    // Clear the in-flight flag when the REAL work settles, even if we stopped
    // awaiting it because the cycle timed out. The catch keeps a late rejection
    // (after the timeout already won the race) from surfacing as an unhandled
    // rejection.
    void work
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(route.warpRouteId));

    try {
      await withTimeout(
        work,
        this.routeCycleTimeoutMs,
        `Route cycle for ${route.warpRouteId}`,
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

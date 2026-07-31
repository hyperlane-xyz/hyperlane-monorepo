import { expect } from 'chai';

import type { IRegistry } from '@hyperlane-xyz/registry';

import {
  type MultiWarpMonitorConfig,
  MultiWarpMonitor,
  withTimeout,
} from './multi-monitor.js';
import type { RouteRuntime, SharedMonitorContext } from './monitor.js';

const FAKE_CTX = {} as SharedMonitorContext;

// Test double that replaces the registry-backed route build with controllable
// behavior and exposes the protected resolution methods.
class TestMultiWarpMonitor extends MultiWarpMonitor {
  buildCalls: string[] = [];

  constructor(
    config: MultiWarpMonitorConfig,
    private readonly behavior: (warpRouteId: string) => Promise<RouteRuntime>,
  ) {
    super(config, {} as IRegistry);
  }

  protected override async buildRoute(
    _ctx: SharedMonitorContext,
    warpRouteId: string,
  ): Promise<RouteRuntime> {
    this.buildCalls.push(warpRouteId);
    return this.behavior(warpRouteId);
  }

  async runInitializeRoutes(
    ctx: SharedMonitorContext,
  ): Promise<{ routes: RouteRuntime[]; unresolvedRouteIds: string[] }> {
    return this.initializeRoutes(ctx);
  }

  async runResolvePendingRoutes(
    ctx: SharedMonitorContext,
    routes: RouteRuntime[],
    unresolvedRouteIds: string[],
  ): Promise<void> {
    return this.resolvePendingRoutes(ctx, routes, unresolvedRouteIds);
  }
}

function makeConfig(
  overrides: Partial<MultiWarpMonitorConfig> = {},
): MultiWarpMonitorConfig {
  return {
    warpRouteIds: ['MULTI/hung'],
    checkFrequency: 1_000,
    concurrency: 2,
    routeResolveTimeoutMs: 10,
    ...overrides,
  };
}

describe('MultiWarpMonitor route resolution', () => {
  it('fails startup when no route can be resolved', async () => {
    const monitor = new TestMultiWarpMonitor(
      makeConfig({ warpRouteIds: ['MULTI/a', 'MULTI/b'] }),
      async () => {
        throw new Error('registry down');
      },
    );

    let rejected: Error | undefined;
    try {
      await monitor.runInitializeRoutes(FAKE_CTX);
    } catch (error: unknown) {
      rejected = error instanceof Error ? error : new Error(String(error));
    }

    // A monitor that resolves zero routes must crash rather than serve /metrics
    // while silently covering nothing.
    expect(rejected).to.exist;
    expect(rejected!.message).to.equal(
      'No warp routes could be resolved for monitoring',
    );
    expect(monitor.buildCalls).to.have.members(['MULTI/a', 'MULTI/b']);
  });

  it('does not re-issue a build for a route whose prior build has not settled', async () => {
    // Models a hung getWarpRoute: the build never settles, so withTimeout stops
    // awaiting it but cannot cancel it. Subsequent retries must skip the route
    // rather than stacking a fresh in-flight build each pass.
    const neverSettles = new Promise<RouteRuntime>(() => {});
    const monitor = new TestMultiWarpMonitor(
      makeConfig({ warpRouteIds: ['MULTI/hung'] }),
      async () => neverSettles,
    );

    const routes: RouteRuntime[] = [];
    const unresolvedRouteIds = ['MULTI/hung'];

    await monitor.runResolvePendingRoutes(FAKE_CTX, routes, unresolvedRouteIds);
    await monitor.runResolvePendingRoutes(FAKE_CTX, routes, unresolvedRouteIds);
    await monitor.runResolvePendingRoutes(FAKE_CTX, routes, unresolvedRouteIds);

    // Exactly one build was ever issued despite three retry passes.
    expect(monitor.buildCalls).to.deep.equal(['MULTI/hung']);
    expect(routes).to.have.length(0);
    expect(unresolvedRouteIds).to.deep.equal(['MULTI/hung']);
  });
});

describe('withTimeout', () => {
  it('rejects a never-settling promise after the timeout instead of hanging', async () => {
    // A registry read that never resolves models a hung getWarpRoute /
    // getWarpDeployConfig. Route resolution wraps each build in withTimeout so
    // this cannot block startup or the background retry that runs alongside
    // already-active route cycles.
    const neverSettles = new Promise<string>(() => {});

    let rejected: Error | undefined;
    try {
      await withTimeout(neverSettles, 20, 'Route resolution for MULTI/hung');
    } catch (error: unknown) {
      rejected = error instanceof Error ? error : new Error(String(error));
    }

    expect(rejected).to.exist;
    expect(rejected!.message).to.equal(
      'Route resolution for MULTI/hung timed out after 20ms',
    );
  });

  it('returns the value when the promise settles before the timeout', async () => {
    const value = await withTimeout(
      Promise.resolve('ok'),
      1_000,
      'Route resolution for MULTI/fast',
    );
    expect(value).to.equal('ok');
  });
});

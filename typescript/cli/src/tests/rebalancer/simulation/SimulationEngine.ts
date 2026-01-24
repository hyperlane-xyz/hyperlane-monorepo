/**
 * SimulationEngine
 *
 * Core discrete event simulation engine for rebalancer testing.
 */
import { BridgeSimulator } from './BridgeSimulator.js';
import { MetricsCollector } from './MetricsCollector.js';
import type {
  BridgeConfig,
  ISimulationStrategy,
  PendingRebalance,
  PendingTransfer,
  RebalancingRoute,
  SimulationConfig,
  SimulationResults,
  SimulationRunOptions,
  SimulationState,
  TimeSeriesPoint,
  Transfer,
} from './types.js';

/**
 * Discrete event simulation engine.
 *
 * Simulates transfer traffic and rebalancer behavior over time,
 * tracking collateral balances and measuring outcomes.
 */
export class SimulationEngine {
  private readonly config: SimulationConfig;
  private readonly bridgeSimulator: BridgeSimulator;
  private readonly metrics: MetricsCollector;

  private state!: SimulationState;

  constructor(config: SimulationConfig, seed?: number) {
    this.config = config;
    this.bridgeSimulator = new BridgeSimulator(seed);
    this.metrics = new MetricsCollector();
  }

  /**
   * Run the simulation.
   */
  async run(options: SimulationRunOptions): Promise<SimulationResults> {
    const {
      trafficSource,
      rebalancer,
      durationMs,
      tickIntervalMs,
      rebalancerIntervalMs,
    } = options;

    // Initialize state
    this.state = {
      currentTime: 0,
      collateralBalances: { ...this.config.initialBalances },
      pendingTransfers: [],
      pendingRebalances: [],
    };

    this.metrics.initialize(this.config.warpTransferLatencyMs);

    let lastRebalancerTime = 0;
    let lastTimeSeriesTime = 0;
    const timeSeriesIntervalMs = Math.max(tickIntervalMs * 10, 1000); // Record every 10 ticks or 1s

    // Main simulation loop
    while (this.state.currentTime < durationMs) {
      // 1. Inject new transfers from traffic source
      const newTransfers = trafficSource.getTransfers(
        this.state.currentTime,
        this.state.currentTime + tickIntervalMs,
      );
      this.injectTransfers(newTransfers);

      // 2. Process transfer arrivals
      this.processTransferArrivals();

      // 3. Process rebalance completions
      this.processRebalanceCompletions();

      // 4. Check if waiting transfers can now complete
      this.checkWaitingTransfers();

      // 5. Check for stuck transfers (timeout)
      this.checkStuckTransfers();

      // 6. Run rebalancer if interval elapsed
      if (this.state.currentTime - lastRebalancerTime >= rebalancerIntervalMs) {
        this.runRebalancer(rebalancer);
        lastRebalancerTime = this.state.currentTime;
      }

      // 7. Record time series
      if (this.state.currentTime - lastTimeSeriesTime >= timeSeriesIntervalMs) {
        this.recordTimeSeries();
        lastTimeSeriesTime = this.state.currentTime;
      }

      // Advance time
      this.state.currentTime += tickIntervalMs;
    }

    // Final time series point
    this.recordTimeSeries();

    // Mark any remaining pending transfers as stuck
    for (const pt of this.state.pendingTransfers) {
      if (pt.status !== 'completed') {
        pt.status = 'stuck';
        this.metrics.recordStuckTransfer(pt);
      }
    }

    return this.metrics.finalize(durationMs);
  }

  /**
   * Inject new transfers into the simulation.
   */
  private injectTransfers(transfers: Transfer[]): void {
    for (const transfer of transfers) {
      const arrivalTime =
        transfer.timestamp + this.config.warpTransferLatencyMs;

      const pendingTransfer: PendingTransfer = {
        transfer,
        arrivalTime,
        status: 'in_flight',
      };

      this.state.pendingTransfers.push(pendingTransfer);
    }
  }

  /**
   * Process transfers that have arrived at destination.
   */
  private processTransferArrivals(): void {
    for (const pt of this.state.pendingTransfers) {
      if (pt.status !== 'in_flight') continue;
      if (this.state.currentTime < pt.arrivalTime) continue;

      // Transfer has arrived - check if collateral is available
      const destBalance =
        this.state.collateralBalances[pt.transfer.destination] ?? 0n;

      if (destBalance >= pt.transfer.amount) {
        // Collateral available - complete immediately
        this.state.collateralBalances[pt.transfer.destination] =
          destBalance - pt.transfer.amount;
        pt.status = 'completed';
        pt.completedAt = this.state.currentTime;
        this.metrics.recordCompletedTransfer(pt);
      } else {
        // No collateral - wait
        pt.status = 'waiting_collateral';
      }
    }
  }

  /**
   * Process rebalances that have completed.
   */
  private processRebalanceCompletions(): void {
    for (const pr of this.state.pendingRebalances) {
      if (pr.status !== 'in_flight') continue;
      if (this.state.currentTime < pr.expectedArrivalAt) continue;

      // Check if it failed
      const bridgeKey = `${pr.route.origin}-${pr.route.destination}`;
      const bridgeConfig = this.config.bridges[bridgeKey];

      if (bridgeConfig && this.bridgeSimulator.shouldFail(bridgeConfig)) {
        pr.status = 'failed';
        this.metrics.recordFailedRebalance(pr);
      } else {
        // Success - add collateral to destination
        const destBalance =
          this.state.collateralBalances[pr.route.destination] ?? 0n;
        this.state.collateralBalances[pr.route.destination] =
          destBalance + pr.route.amount;
        pr.status = 'completed';
        this.metrics.recordCompletedRebalance(pr);
      }
    }

    // Clean up completed/failed rebalances
    this.state.pendingRebalances = this.state.pendingRebalances.filter(
      (pr) => pr.status === 'in_flight',
    );
  }

  /**
   * Check if waiting transfers can now complete.
   */
  private checkWaitingTransfers(): void {
    // Sort by arrival time (FIFO)
    const waiting = this.state.pendingTransfers
      .filter((pt) => pt.status === 'waiting_collateral')
      .sort((a, b) => a.arrivalTime - b.arrivalTime);

    for (const pt of waiting) {
      const destBalance =
        this.state.collateralBalances[pt.transfer.destination] ?? 0n;

      if (destBalance >= pt.transfer.amount) {
        // Collateral now available
        this.state.collateralBalances[pt.transfer.destination] =
          destBalance - pt.transfer.amount;
        pt.status = 'completed';
        pt.collateralAvailableAt = this.state.currentTime;
        pt.completedAt = this.state.currentTime;
        this.metrics.recordCompletedTransfer(pt);
      }
    }
  }

  /**
   * Check for stuck transfers (exceeded timeout).
   */
  private checkStuckTransfers(): void {
    for (const pt of this.state.pendingTransfers) {
      if (pt.status !== 'waiting_collateral') continue;

      const waitTime = this.state.currentTime - pt.arrivalTime;
      if (waitTime > this.config.transferTimeoutMs) {
        pt.status = 'stuck';
        this.metrics.recordStuckTransfer(pt);
      }
    }

    // Clean up completed/stuck transfers
    this.state.pendingTransfers = this.state.pendingTransfers.filter(
      (pt) => pt.status === 'in_flight' || pt.status === 'waiting_collateral',
    );
  }

  /**
   * Run the rebalancer and initiate any proposed routes.
   */
  private runRebalancer(rebalancer: ISimulationStrategy): void {
    // Build inflight context
    const pendingRebalances: RebalancingRoute[] =
      this.state.pendingRebalances.map((pr) => pr.route);

    // Pending transfers that need collateral
    const pendingTransfers: RebalancingRoute[] = this.state.pendingTransfers
      .filter(
        (pt) => pt.status === 'in_flight' || pt.status === 'waiting_collateral',
      )
      .map((pt) => ({
        origin: pt.transfer.origin,
        destination: pt.transfer.destination,
        amount: pt.transfer.amount,
      }));

    // Get routes from rebalancer
    const routes = rebalancer.getRebalancingRoutes(
      { ...this.state.collateralBalances },
      { pendingRebalances, pendingTransfers },
    );

    // Initiate rebalances
    for (const route of routes) {
      this.initiateRebalance(route);
    }
  }

  /**
   * Initiate a rebalance.
   */
  private initiateRebalance(route: RebalancingRoute): void {
    const bridgeKey = `${route.origin}-${route.destination}`;
    const bridgeConfig = this.config.bridges[bridgeKey];

    if (!bridgeConfig) {
      // No bridge configured for this route
      return;
    }

    // Check if origin has enough balance
    const originBalance = this.state.collateralBalances[route.origin] ?? 0n;
    if (originBalance < route.amount) {
      // Not enough balance to rebalance
      return;
    }

    // Deduct from origin immediately
    this.state.collateralBalances[route.origin] = originBalance - route.amount;

    // Calculate latency and cost
    const latency = this.bridgeSimulator.getLatency(bridgeConfig);
    const gasPrice = this.config.gasPrices[route.origin] ?? 30_000_000_000n; // 30 gwei default
    const cost = this.bridgeSimulator.getCost(
      bridgeConfig,
      route.amount,
      gasPrice,
      this.config.ethPriceUsd,
      this.config.tokenPriceUsd ?? 1, // Default to $1 (stablecoin)
    );

    const pendingRebalance: PendingRebalance = {
      route,
      initiatedAt: this.state.currentTime,
      expectedArrivalAt: this.state.currentTime + latency,
      status: 'in_flight',
      cost,
    };

    this.state.pendingRebalances.push(pendingRebalance);
  }

  /**
   * Record a time series point.
   */
  private recordTimeSeries(): void {
    const point: TimeSeriesPoint = {
      timestamp: this.state.currentTime,
      balances: { ...this.state.collateralBalances },
      pendingTransfers: this.state.pendingTransfers.filter(
        (pt) => pt.status === 'in_flight',
      ).length,
      waitingTransfers: this.state.pendingTransfers.filter(
        (pt) => pt.status === 'waiting_collateral',
      ).length,
      pendingRebalances: this.state.pendingRebalances.filter(
        (pr) => pr.status === 'in_flight',
      ).length,
    };

    this.metrics.recordTimeSeriesPoint(point);
  }

  /**
   * Get current state (for debugging).
   */
  getState(): SimulationState {
    return { ...this.state };
  }
}

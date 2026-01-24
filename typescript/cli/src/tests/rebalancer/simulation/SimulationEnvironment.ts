/**
 * SimulationEnvironment
 *
 * A simulation environment that any rebalancer implementation can interact with.
 * This is decoupled from any specific rebalancer abstraction - it just provides
 * an environment that simulates warp route traffic and bridge behavior.
 *
 * Rebalancers interact with the environment by:
 * 1. Observing state (balances, pending transfers, events)
 * 2. Executing rebalance actions
 *
 * The environment handles:
 * - Simulating warp transfer traffic
 * - Tracking collateral balances
 * - Simulating bridge latency and costs
 * - Measuring outcomes (availability, latency, cost)
 */
import type { Address } from '@hyperlane-xyz/utils';

import { BridgeSimulator } from './BridgeSimulator.js';
import { MetricsCollector } from './MetricsCollector.js';
import type {
  BridgeConfig,
  PendingRebalance,
  PendingTransfer,
  RebalancingRoute,
  SimulationConfig,
  SimulationResults,
  TimeSeriesPoint,
  TrafficSource,
  Transfer,
} from './types.js';

// ============================================================================
// Event Types - What the environment emits
// ============================================================================

export type SimulationEventType =
  | 'tick' // Time advanced
  | 'transfer_arrived' // A warp transfer arrived at destination
  | 'transfer_completed' // A transfer was fulfilled with collateral
  | 'transfer_waiting' // A transfer is waiting for collateral
  | 'transfer_stuck' // A transfer timed out
  | 'rebalance_initiated' // A rebalance was started
  | 'rebalance_completed' // A rebalance arrived
  | 'rebalance_failed' // A rebalance failed
  | 'balance_changed'; // Collateral balance changed

export interface SimulationEvent {
  type: SimulationEventType;
  time: number;
  data: Record<string, unknown>;
}

export type EventHandler = (event: SimulationEvent) => void;

// ============================================================================
// Environment State - What rebalancers can observe
// ============================================================================

export interface EnvironmentState {
  /** Current simulation time (ms) */
  currentTime: number;

  /** Collateral balances by chain */
  balances: Record<string, bigint>;

  /** Transfers that are in-flight (not yet arrived) */
  inFlightTransfers: ReadonlyArray<{
    id: string;
    origin: string;
    destination: string;
    amount: bigint;
    initiatedAt: number;
    expectedArrivalAt: number;
  }>;

  /** Transfers waiting for collateral */
  waitingTransfers: ReadonlyArray<{
    id: string;
    origin: string;
    destination: string;
    amount: bigint;
    arrivedAt: number;
    waitingSince: number;
  }>;

  /** Rebalances that are in-flight */
  inFlightRebalances: ReadonlyArray<{
    id: string;
    origin: string;
    destination: string;
    amount: bigint;
    initiatedAt: number;
    expectedArrivalAt: number;
  }>;
}

// ============================================================================
// Rebalance Request - What rebalancers can do
// ============================================================================

export interface RebalanceRequest {
  origin: string;
  destination: string;
  amount: bigint;
  /** Optional: specify which bridge to use */
  bridge?: Address;
  /** Optional: metadata for tracking */
  metadata?: Record<string, unknown>;
}

export interface RebalanceResult {
  success: boolean;
  id?: string;
  error?: string;
  estimatedArrivalTime?: number;
  estimatedCostUsd?: number;
}

// ============================================================================
// Rebalancer Controller Interface
// ============================================================================

/**
 * Interface that any rebalancer implementation can use to control the simulation.
 *
 * This is NOT a strategy interface - it's a controller that gives rebalancers
 * full control over how they interact with the environment.
 */
export interface IRebalancerController {
  /**
   * Called when the simulation starts.
   * Use this to set up any internal state, subscribe to events, etc.
   */
  onStart?(env: SimulationEnvironment): void | Promise<void>;

  /**
   * Called on each simulation tick.
   * This is optional - event-driven rebalancers might not need this.
   */
  onTick?(env: SimulationEnvironment, deltaMs: number): void | Promise<void>;

  /**
   * Called when the simulation ends.
   * Use this to clean up any internal state.
   */
  onEnd?(env: SimulationEnvironment): void | Promise<void>;
}

// ============================================================================
// Simulation Environment
// ============================================================================

export interface SimulationEnvironmentConfig extends SimulationConfig {
  /** How often to call onTick (if controller implements it) */
  tickIntervalMs: number;
}

/**
 * The simulation environment that rebalancers interact with.
 */
export class SimulationEnvironment {
  private readonly config: SimulationEnvironmentConfig;
  private readonly bridgeSimulator: BridgeSimulator;
  private readonly metrics: MetricsCollector;

  private currentTime = 0;
  private collateralBalances: Record<string, bigint> = {};
  private pendingTransfers: PendingTransfer[] = [];
  private pendingRebalances: PendingRebalance[] = [];
  private rebalanceIdCounter = 0;

  private eventHandlers: EventHandler[] = [];

  constructor(config: SimulationEnvironmentConfig, seed?: number) {
    this.config = config;
    this.bridgeSimulator = new BridgeSimulator(seed);
    this.metrics = new MetricsCollector();
  }

  // ==========================================================================
  // State Observation
  // ==========================================================================

  /**
   * Get current environment state (read-only snapshot).
   */
  getState(): EnvironmentState {
    return {
      currentTime: this.currentTime,
      balances: { ...this.collateralBalances },
      inFlightTransfers: this.pendingTransfers
        .filter((pt) => pt.status === 'in_flight')
        .map((pt) => ({
          id: pt.transfer.id,
          origin: pt.transfer.origin,
          destination: pt.transfer.destination,
          amount: pt.transfer.amount,
          initiatedAt: pt.transfer.timestamp,
          expectedArrivalAt: pt.arrivalTime,
        })),
      waitingTransfers: this.pendingTransfers
        .filter((pt) => pt.status === 'waiting_collateral')
        .map((pt) => ({
          id: pt.transfer.id,
          origin: pt.transfer.origin,
          destination: pt.transfer.destination,
          amount: pt.transfer.amount,
          arrivedAt: pt.arrivalTime,
          waitingSince: pt.arrivalTime,
        })),
      inFlightRebalances: this.pendingRebalances
        .filter((pr) => pr.status === 'in_flight')
        .map((pr) => ({
          id: `rebalance-${pr.initiatedAt}`,
          origin: pr.route.origin,
          destination: pr.route.destination,
          amount: pr.route.amount,
          initiatedAt: pr.initiatedAt,
          expectedArrivalAt: pr.expectedArrivalAt,
        })),
    };
  }

  /**
   * Get current time.
   */
  getCurrentTime(): number {
    return this.currentTime;
  }

  /**
   * Get balance for a specific chain.
   */
  getBalance(chain: string): bigint {
    return this.collateralBalances[chain] ?? 0n;
  }

  /**
   * Get all balances.
   */
  getBalances(): Record<string, bigint> {
    return { ...this.collateralBalances };
  }

  /**
   * Get available bridges.
   */
  getAvailableBridges(): Array<{
    origin: string;
    destination: string;
    config: BridgeConfig;
  }> {
    return Object.entries(this.config.bridges).map(([key, config]) => {
      const [origin, destination] = key.split('-');
      return { origin, destination, config };
    });
  }

  // ==========================================================================
  // Actions
  // ==========================================================================

  /**
   * Execute a rebalance.
   * Returns immediately with estimated arrival time and cost.
   */
  executeRebalance(request: RebalanceRequest): RebalanceResult {
    const bridgeKey = `${request.origin}-${request.destination}`;
    const bridgeConfig = this.config.bridges[bridgeKey];

    if (!bridgeConfig) {
      return {
        success: false,
        error: `No bridge configured for ${bridgeKey}`,
      };
    }

    const originBalance = this.collateralBalances[request.origin] ?? 0n;
    if (originBalance < request.amount) {
      return {
        success: false,
        error: `Insufficient balance on ${request.origin}: have ${originBalance}, need ${request.amount}`,
      };
    }

    // Deduct from origin immediately
    this.collateralBalances[request.origin] = originBalance - request.amount;

    // Calculate latency and cost
    const latency = this.bridgeSimulator.getLatency(bridgeConfig);
    const gasPrice = this.config.gasPrices[request.origin] ?? 30_000_000_000n;
    const cost = this.bridgeSimulator.getCost(
      bridgeConfig,
      request.amount,
      gasPrice,
      this.config.ethPriceUsd,
      this.config.tokenPriceUsd ?? 1,
    );

    const id = `rebalance-${++this.rebalanceIdCounter}`;

    const pendingRebalance: PendingRebalance = {
      route: {
        origin: request.origin,
        destination: request.destination,
        amount: request.amount,
        bridge: request.bridge,
      },
      initiatedAt: this.currentTime,
      expectedArrivalAt: this.currentTime + latency,
      status: 'in_flight',
      cost,
    };

    this.pendingRebalances.push(pendingRebalance);

    this.emit({
      type: 'rebalance_initiated',
      time: this.currentTime,
      data: {
        id,
        origin: request.origin,
        destination: request.destination,
        amount: request.amount.toString(),
        expectedArrivalAt: pendingRebalance.expectedArrivalAt,
        estimatedCostUsd: cost.usd,
      },
    });

    this.emit({
      type: 'balance_changed',
      time: this.currentTime,
      data: {
        chain: request.origin,
        oldBalance: originBalance.toString(),
        newBalance: this.collateralBalances[request.origin].toString(),
        reason: 'rebalance_sent',
      },
    });

    return {
      success: true,
      id,
      estimatedArrivalTime: pendingRebalance.expectedArrivalAt,
      estimatedCostUsd: cost.usd,
    };
  }

  // ==========================================================================
  // Event Subscription
  // ==========================================================================

  /**
   * Subscribe to simulation events.
   */
  on(handler: EventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const index = this.eventHandlers.indexOf(handler);
      if (index !== -1) {
        this.eventHandlers.splice(index, 1);
      }
    };
  }

  private emit(event: SimulationEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error('Event handler error:', e);
      }
    }
  }

  // ==========================================================================
  // Simulation Execution
  // ==========================================================================

  /**
   * Run the simulation with a rebalancer controller.
   */
  async run(
    trafficSource: TrafficSource,
    controller: IRebalancerController,
    durationMs: number,
  ): Promise<SimulationResults> {
    // Initialize state
    this.currentTime = 0;
    this.collateralBalances = { ...this.config.initialBalances };
    this.pendingTransfers = [];
    this.pendingRebalances = [];
    this.rebalanceIdCounter = 0;

    this.metrics.initialize(this.config.warpTransferLatencyMs);

    // Let controller set up
    await controller.onStart?.(this);

    let lastTimeSeriesTime = 0;
    const timeSeriesIntervalMs = Math.max(
      this.config.tickIntervalMs * 10,
      1000,
    );

    // Main simulation loop
    while (this.currentTime < durationMs) {
      // 1. Inject new transfers from traffic source
      const newTransfers = trafficSource.getTransfers(
        this.currentTime,
        this.currentTime + this.config.tickIntervalMs,
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

      // 6. Call controller tick
      await controller.onTick?.(this, this.config.tickIntervalMs);

      // 7. Record time series
      if (this.currentTime - lastTimeSeriesTime >= timeSeriesIntervalMs) {
        this.recordTimeSeries();
        lastTimeSeriesTime = this.currentTime;
      }

      // Emit tick event
      this.emit({
        type: 'tick',
        time: this.currentTime,
        data: { deltaMs: this.config.tickIntervalMs },
      });

      // Advance time
      this.currentTime += this.config.tickIntervalMs;
    }

    // Final time series point
    this.recordTimeSeries();

    // Mark any remaining pending transfers as stuck
    for (const pt of this.pendingTransfers) {
      if (pt.status !== 'completed') {
        pt.status = 'stuck';
        this.metrics.recordStuckTransfer(pt);
      }
    }

    // Let controller clean up
    await controller.onEnd?.(this);

    return this.metrics.finalize(durationMs);
  }

  // ==========================================================================
  // Internal Simulation Logic
  // ==========================================================================

  private injectTransfers(transfers: Transfer[]): void {
    for (const transfer of transfers) {
      const arrivalTime =
        transfer.timestamp + this.config.warpTransferLatencyMs;

      const pendingTransfer: PendingTransfer = {
        transfer,
        arrivalTime,
        status: 'in_flight',
      };

      this.pendingTransfers.push(pendingTransfer);
    }
  }

  private processTransferArrivals(): void {
    for (const pt of this.pendingTransfers) {
      if (pt.status !== 'in_flight') continue;
      if (this.currentTime < pt.arrivalTime) continue;

      const destBalance =
        this.collateralBalances[pt.transfer.destination] ?? 0n;

      this.emit({
        type: 'transfer_arrived',
        time: this.currentTime,
        data: {
          id: pt.transfer.id,
          origin: pt.transfer.origin,
          destination: pt.transfer.destination,
          amount: pt.transfer.amount.toString(),
          collateralAvailable: destBalance >= pt.transfer.amount,
        },
      });

      if (destBalance >= pt.transfer.amount) {
        this.collateralBalances[pt.transfer.destination] =
          destBalance - pt.transfer.amount;
        pt.status = 'completed';
        pt.completedAt = this.currentTime;
        this.metrics.recordCompletedTransfer(pt);

        this.emit({
          type: 'transfer_completed',
          time: this.currentTime,
          data: {
            id: pt.transfer.id,
            destination: pt.transfer.destination,
            amount: pt.transfer.amount.toString(),
            waitTime: 0,
          },
        });

        this.emit({
          type: 'balance_changed',
          time: this.currentTime,
          data: {
            chain: pt.transfer.destination,
            oldBalance: destBalance.toString(),
            newBalance:
              this.collateralBalances[pt.transfer.destination].toString(),
            reason: 'transfer_fulfilled',
          },
        });
      } else {
        pt.status = 'waiting_collateral';

        this.emit({
          type: 'transfer_waiting',
          time: this.currentTime,
          data: {
            id: pt.transfer.id,
            destination: pt.transfer.destination,
            amountNeeded: pt.transfer.amount.toString(),
            amountAvailable: destBalance.toString(),
            shortfall: (pt.transfer.amount - destBalance).toString(),
          },
        });
      }
    }
  }

  private processRebalanceCompletions(): void {
    for (const pr of this.pendingRebalances) {
      if (pr.status !== 'in_flight') continue;
      if (this.currentTime < pr.expectedArrivalAt) continue;

      const bridgeKey = `${pr.route.origin}-${pr.route.destination}`;
      const bridgeConfig = this.config.bridges[bridgeKey];

      if (bridgeConfig && this.bridgeSimulator.shouldFail(bridgeConfig)) {
        pr.status = 'failed';
        this.metrics.recordFailedRebalance(pr);

        this.emit({
          type: 'rebalance_failed',
          time: this.currentTime,
          data: {
            origin: pr.route.origin,
            destination: pr.route.destination,
            amount: pr.route.amount.toString(),
          },
        });
      } else {
        const destBalance = this.collateralBalances[pr.route.destination] ?? 0n;
        this.collateralBalances[pr.route.destination] =
          destBalance + pr.route.amount;
        pr.status = 'completed';
        this.metrics.recordCompletedRebalance(pr);

        this.emit({
          type: 'rebalance_completed',
          time: this.currentTime,
          data: {
            origin: pr.route.origin,
            destination: pr.route.destination,
            amount: pr.route.amount.toString(),
            costUsd: pr.cost.usd,
          },
        });

        this.emit({
          type: 'balance_changed',
          time: this.currentTime,
          data: {
            chain: pr.route.destination,
            oldBalance: destBalance.toString(),
            newBalance:
              this.collateralBalances[pr.route.destination].toString(),
            reason: 'rebalance_received',
          },
        });
      }
    }

    this.pendingRebalances = this.pendingRebalances.filter(
      (pr) => pr.status === 'in_flight',
    );
  }

  private checkWaitingTransfers(): void {
    const waiting = this.pendingTransfers
      .filter((pt) => pt.status === 'waiting_collateral')
      .sort((a, b) => a.arrivalTime - b.arrivalTime);

    for (const pt of waiting) {
      const destBalance =
        this.collateralBalances[pt.transfer.destination] ?? 0n;

      if (destBalance >= pt.transfer.amount) {
        this.collateralBalances[pt.transfer.destination] =
          destBalance - pt.transfer.amount;
        pt.status = 'completed';
        pt.collateralAvailableAt = this.currentTime;
        pt.completedAt = this.currentTime;
        this.metrics.recordCompletedTransfer(pt);

        const waitTime = this.currentTime - pt.arrivalTime;

        this.emit({
          type: 'transfer_completed',
          time: this.currentTime,
          data: {
            id: pt.transfer.id,
            destination: pt.transfer.destination,
            amount: pt.transfer.amount.toString(),
            waitTime,
          },
        });

        this.emit({
          type: 'balance_changed',
          time: this.currentTime,
          data: {
            chain: pt.transfer.destination,
            oldBalance: destBalance.toString(),
            newBalance:
              this.collateralBalances[pt.transfer.destination].toString(),
            reason: 'transfer_fulfilled',
          },
        });
      }
    }
  }

  private checkStuckTransfers(): void {
    for (const pt of this.pendingTransfers) {
      if (pt.status !== 'waiting_collateral') continue;

      const waitTime = this.currentTime - pt.arrivalTime;
      if (waitTime > this.config.transferTimeoutMs) {
        pt.status = 'stuck';
        this.metrics.recordStuckTransfer(pt);

        this.emit({
          type: 'transfer_stuck',
          time: this.currentTime,
          data: {
            id: pt.transfer.id,
            destination: pt.transfer.destination,
            amount: pt.transfer.amount.toString(),
            waitTime,
          },
        });
      }
    }

    this.pendingTransfers = this.pendingTransfers.filter(
      (pt) => pt.status === 'in_flight' || pt.status === 'waiting_collateral',
    );
  }

  private recordTimeSeries(): void {
    const point: TimeSeriesPoint = {
      timestamp: this.currentTime,
      balances: { ...this.collateralBalances },
      pendingTransfers: this.pendingTransfers.filter(
        (pt) => pt.status === 'in_flight',
      ).length,
      waitingTransfers: this.pendingTransfers.filter(
        (pt) => pt.status === 'waiting_collateral',
      ).length,
      pendingRebalances: this.pendingRebalances.filter(
        (pr) => pr.status === 'in_flight',
      ).length,
    };

    this.metrics.recordTimeSeriesPoint(point);
  }
}

// ============================================================================
// Adapter: Convert ISimulationStrategy to IRebalancerController
// ============================================================================

/**
 * Adapter that converts the old ISimulationStrategy interface to the new
 * IRebalancerController interface.
 *
 * This maintains backward compatibility with existing strategies.
 */
export function strategyToController(
  strategy: {
    getRebalancingRoutes(
      balances: Record<string, bigint>,
      inflight: {
        pendingRebalances: RebalancingRoute[];
        pendingTransfers: RebalancingRoute[];
      },
    ): RebalancingRoute[];
  },
  intervalMs: number,
): IRebalancerController {
  let lastRunTime = 0;

  return {
    onTick(env, _deltaMs) {
      const state = env.getState();

      if (state.currentTime - lastRunTime < intervalMs) {
        return;
      }
      lastRunTime = state.currentTime;

      // Build inflight context in the format the strategy expects
      const pendingRebalances: RebalancingRoute[] =
        state.inFlightRebalances.map((r) => ({
          origin: r.origin,
          destination: r.destination,
          amount: r.amount,
        }));

      const pendingTransfers: RebalancingRoute[] = [
        ...state.inFlightTransfers,
        ...state.waitingTransfers,
      ].map((t) => ({
        origin: t.origin,
        destination: t.destination,
        amount: t.amount,
      }));

      // Get routes from strategy
      const routes = strategy.getRebalancingRoutes(state.balances, {
        pendingRebalances,
        pendingTransfers,
      });

      // Execute rebalances
      for (const route of routes) {
        env.executeRebalance({
          origin: route.origin,
          destination: route.destination,
          amount: route.amount,
          bridge: route.bridge,
        });
      }
    },
  };
}

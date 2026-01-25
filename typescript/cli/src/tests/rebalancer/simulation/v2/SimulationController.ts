/**
 * SimulationController
 *
 * Orchestrates the entire simulation:
 * - Manages time (SimulationClock)
 * - Generates traffic (TrafficGenerator)
 * - Tracks pending transfers and bridges
 * - Completes transfers after simulated delays
 * - Integrates with the real RebalancerService
 * - Collects metrics
 */
import type { Logger } from 'pino';

import type { RebalancerService } from '@hyperlane-xyz/rebalancer';
import type { MultiProvider } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type { RebalancerTestSetup } from '../../harness/setup.js';
import { MockExplorerServer, createInflightMessage } from '../../harness/mock-explorer.js';
import { SimulationClock } from './SimulationClock.js';
import { TrafficGenerator } from './TrafficGenerator.js';
import type {
  BridgeMetric,
  PendingBridgeTransfer,
  PendingWarpTransfer,
  ScheduledTransfer,
  SimulatedBridgeConfig,
  SimulationResults,
  SimulationRun,
  TimeSeriesPoint,
  TransferMetric,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface SimulationControllerConfig {
  /** Test setup with deployed contracts */
  setup: RebalancerTestSetup;

  /** The rebalancer service to test */
  rebalancerService: RebalancerService;

  /** Mock explorer server */
  explorerServer: MockExplorerServer;

  /** Warp transfer delay (time for Hyperlane message delivery) in ms */
  warpTransferDelayMs: number;

  /** Bridge configurations by "origin-dest" key */
  bridgeConfigs: Record<string, SimulatedBridgeConfig>;

  /** How often to let the rebalancer check (in simulation time) */
  rebalancerIntervalMs: number;

  /** Time step for simulation (in ms) */
  timeStepMs: number;

  /** Optional logger */
  logger?: Logger;
}

// ============================================================================
// Simulation Controller
// ============================================================================

export class SimulationController {
  private readonly config: SimulationControllerConfig;
  private readonly clock: SimulationClock;
  private readonly trafficGenerator: TrafficGenerator;
  private readonly logger?: Logger;

  // Pending items
  private pendingWarpTransfers: Map<string, PendingWarpTransfer> = new Map();
  private pendingBridgeTransfers: Map<string, PendingBridgeTransfer> = new Map();

  // Track executed transfers to avoid double-execution
  private executedTransferIndices: Set<number> = new Set();

  // Metrics
  private transferMetrics: TransferMetric[] = [];
  private bridgeMetrics: BridgeMetric[] = [];
  private timeSeries: TimeSeriesPoint[] = [];

  // State
  private isRunning = false;
  private wallClockStart = 0;

  constructor(config: SimulationControllerConfig) {
    this.config = config;
    this.logger = config.logger;

    // Capture real wall clock time BEFORE creating SimulationClock which installs fake timers
    // We use performance.now() because it's not affected by Sinon fake timers
    this.wallClockStart = performance.now();

    this.clock = new SimulationClock(config.setup.provider);
    this.trafficGenerator = new TrafficGenerator(
      config.setup,
      config.warpTransferDelayMs,
    );
  }

  /**
   * Run the simulation with the given schedule.
   */
  async run(schedule: SimulationRun): Promise<SimulationResults> {
    this.logger?.info({ name: schedule.name }, 'Starting simulation');
    // Reset wall clock start at the beginning of each run
    this.wallClockStart = performance.now();
    this.isRunning = true;

    try {
      // Reset state
      this.pendingWarpTransfers.clear();
      this.pendingBridgeTransfers.clear();
      this.executedTransferIndices.clear();
      this.transferMetrics = [];
      this.bridgeMetrics = [];
      this.timeSeries = [];

      // Apply initial balances if specified
      if (schedule.initialBalances) {
        await this.applyInitialBalances(schedule.initialBalances);
      }

      // Sort transfers by time for efficient processing
      const sortedTransfers = [...schedule.transfers].sort((a, b) => a.time - b.time);

      // Time series recording interval
      const timeSeriesInterval = Math.max(this.config.timeStepMs * 10, 1000);
      let lastTimeSeriesRecord = 0;
      let lastRebalancerRun = 0;

      // Main simulation loop
      while (this.clock.getElapsedTime() < schedule.durationMs && this.isRunning) {
        const currentTime = this.clock.getElapsedTime();

        // 1. Execute any scheduled transfers that are due (time <= currentTime and not yet executed)
        for (let i = 0; i < sortedTransfers.length; i++) {
          if (this.executedTransferIndices.has(i)) continue;
          const transfer = sortedTransfers[i];
          if (transfer.time <= currentTime) {
            this.executedTransferIndices.add(i);
            await this.executeTransfer(transfer, currentTime);
          }
        }

        // 2. Complete any warp transfers that have arrived
        await this.processWarpTransferCompletions(currentTime);

        // 3. Complete any bridge transfers that have finished
        await this.processBridgeCompletions(currentTime);

        // 4. Let rebalancer run (trigger its check cycle)
        if (currentTime - lastRebalancerRun >= this.config.rebalancerIntervalMs) {
          await this.triggerRebalancerCycle();
          lastRebalancerRun = currentTime;
        }

        // 5. Record time series
        if (currentTime - lastTimeSeriesRecord >= timeSeriesInterval) {
          await this.recordTimeSeries(currentTime);
          lastTimeSeriesRecord = currentTime;
        }

        // 6. Advance time
        await this.clock.advanceTime(this.config.timeStepMs);
      }

      // Final time series point
      await this.recordTimeSeries(this.clock.getElapsedTime());

      // Mark any remaining transfers as stuck
      this.markRemainingAsStuck();

      return this.buildResults(schedule);
    } finally {
      this.isRunning = false;
      this.clock.restore();
    }
  }

  /**
   * Stop the simulation early.
   */
  stop(): void {
    this.isRunning = false;
  }

  // ==========================================================================
  // Transfer Execution
  // ==========================================================================

  private async executeTransfer(
    transfer: ScheduledTransfer,
    currentTime: number,
  ): Promise<void> {
    this.logger?.debug(
      { origin: transfer.origin, destination: transfer.destination, amount: transfer.amount.toString() },
      'Executing transfer',
    );

    try {
      const pending = await this.trafficGenerator.executeTransfer(transfer, currentTime);
      // Use txHash as key since messageId might not be unique in anvil (same block)
      this.pendingWarpTransfers.set(pending.txHash, pending);

      // Add to mock explorer
      this.config.explorerServer.addMessage(
        createInflightMessage({
          msgId: pending.messageId,
          originChainId: 31337,
          originDomainId: this.config.setup.getDomain(transfer.origin).domainId,
          destinationChainId: 31337,
          destinationDomainId: this.config.setup.getDomain(transfer.destination).domainId,
          sender: this.config.setup.getWarpRouteAddress(transfer.origin),
          recipient: this.config.setup.getWarpRouteAddress(transfer.destination),
          amount: transfer.amount,
          status: 'pending',
        }),
      );
    } catch (error) {
      this.logger?.error({ error, transfer }, 'Failed to execute transfer');
    }
  }

  // ==========================================================================
  // Transfer Completion
  // ==========================================================================

  private async processWarpTransferCompletions(currentTime: number): Promise<void> {
    for (const [txHash, pending] of this.pendingWarpTransfers) {
      if (pending.completed) continue;
      if (currentTime < pending.expectedCompletionAt) continue;

      this.logger?.debug({ txHash, messageId: pending.messageId }, 'Completing warp transfer');

      try {
        // Deliver the message via mailbox
        await this.trafficGenerator.deliverTransfer(pending);

        // Mark as completed
        pending.completed = true;

        // Update explorer
        const messages = this.config.explorerServer.getMessages();
        const msg = messages.find((m) => m.msgId === pending.messageId);
        if (msg) {
          msg.status = 'delivered';
          this.config.explorerServer.setMessages(messages);
        }

        // Record metric
        this.transferMetrics.push({
          id: pending.messageId,
          origin: pending.origin,
          destination: pending.destination,
          amount: pending.amount,
          initiatedAt: pending.initiatedAt,
          completedAt: currentTime,
          latencyMs: currentTime - pending.initiatedAt,
          waitedForCollateral: false, // TODO: Track this properly
          collateralWaitMs: 0,
        });
      } catch (error) {
        this.logger?.error({ error, txHash }, 'Failed to complete warp transfer');
      }
    }
  }

  private async processBridgeCompletions(currentTime: number): Promise<void> {
    for (const [transferId, pending] of this.pendingBridgeTransfers) {
      if (pending.completed) continue;
      if (currentTime < pending.expectedCompletionAt) continue;

      this.logger?.debug({ transferId }, 'Completing bridge transfer');

      try {
        // Call completeTransfer on the bridge contract
        // TODO: Implement once we have SimulatedTokenBridge deployed

        pending.completed = true;

        // Record metric
        this.bridgeMetrics.push({
          origin: pending.origin,
          destination: pending.destination,
          amount: pending.amount,
          fee: pending.fee,
          bridge: pending.bridge,
          initiatedAt: pending.initiatedAt,
          completedAt: currentTime,
        });
      } catch (error) {
        this.logger?.error({ error, transferId }, 'Failed to complete bridge transfer');
      }
    }
  }

  // ==========================================================================
  // Rebalancer Integration
  // ==========================================================================

  private async triggerRebalancerCycle(): Promise<void> {
    // The rebalancer runs on its own internal loop.
    // With Sinon fake timers, calling tick() will trigger any pending
    // setTimeout/setInterval callbacks in the rebalancer's Monitor.
    //
    // However, we need to be careful not to block forever.
    // For now, we just let time advance and the rebalancer will
    // naturally run its checks when its interval fires.
    //
    // TODO: We may need to manually trigger a rebalancer check
    // if the Sinon approach doesn't work well with async operations.

    this.logger?.trace('Rebalancer cycle triggered');

    // Process any pending async operations
    await this.clock.mineBlock();
  }

  // ==========================================================================
  // Time Series & Metrics
  // ==========================================================================

  private async recordTimeSeries(currentTime: number): Promise<void> {
    const balances: Record<string, bigint> = {};

    for (const [domainName, token] of Object.entries(this.config.setup.tokens)) {
      const warpRouteAddress = this.config.setup.getWarpRouteAddress(domainName);
      const balance = await token.balanceOf(warpRouteAddress);
      balances[domainName] = BigInt(balance.toString());
    }

    this.timeSeries.push({
      time: currentTime,
      balances,
      pendingTransfers: [...this.pendingWarpTransfers.values()].filter((t) => !t.completed).length,
      pendingBridges: [...this.pendingBridgeTransfers.values()].filter((t) => !t.completed).length,
      waitingForCollateral: 0, // TODO: Track properly
    });
  }

  private markRemainingAsStuck(): void {
    const currentTime = this.clock.getElapsedTime();

    for (const [_txHash, pending] of this.pendingWarpTransfers) {
      if (!pending.completed) {
        this.transferMetrics.push({
          id: pending.messageId,
          origin: pending.origin,
          destination: pending.destination,
          amount: pending.amount,
          initiatedAt: pending.initiatedAt,
          completedAt: -1, // Indicates stuck
          latencyMs: -1,
          waitedForCollateral: true,
          collateralWaitMs: currentTime - pending.expectedCompletionAt,
        });
      }
    }
  }

  // ==========================================================================
  // Results Building
  // ==========================================================================

  private buildResults(schedule: SimulationRun): SimulationResults {
    const completedTransfers = this.transferMetrics.filter((t) => t.completedAt >= 0);
    const stuckTransfers = this.transferMetrics.filter((t) => t.completedAt < 0);

    const latencies = completedTransfers.map((t) => t.latencyMs).sort((a, b) => a - b);

    return {
      name: schedule.name,
      duration: {
        simulatedMs: schedule.durationMs,
        wallClockMs: Math.round(performance.now() - this.wallClockStart),
      },
      transfers: {
        total: this.transferMetrics.length,
        completed: completedTransfers.length,
        stuck: stuckTransfers.length,
        latency: this.calculateLatencyStats(latencies),
        collateralWait: {
          count: completedTransfers.filter((t) => t.waitedForCollateral).length,
          percent:
            completedTransfers.length > 0
              ? (completedTransfers.filter((t) => t.waitedForCollateral).length / completedTransfers.length) * 100
              : 0,
          meanMs:
            completedTransfers.filter((t) => t.waitedForCollateral).length > 0
              ? completedTransfers
                  .filter((t) => t.waitedForCollateral)
                  .reduce((sum, t) => sum + t.collateralWaitMs, 0) /
                completedTransfers.filter((t) => t.waitedForCollateral).length
              : 0,
        },
      },
      rebalancing: {
        count: this.bridgeMetrics.length,
        totalVolume: this.bridgeMetrics.reduce((sum, b) => sum + b.amount, 0n),
        totalFees: this.bridgeMetrics.reduce((sum, b) => sum + b.fee, 0n),
        totalFeesUsd: 0, // TODO: Calculate based on token price
        byBridge: this.groupBridgeMetrics(),
      },
      timeSeries: this.timeSeries,
    };
  }

  private calculateLatencyStats(latencies: number[]): {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
  } {
    if (latencies.length === 0) {
      return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    }

    const sum = latencies.reduce((a, b) => a + b, 0);
    const percentile = (p: number) => {
      const index = Math.ceil((p / 100) * latencies.length) - 1;
      return latencies[Math.max(0, index)];
    };

    return {
      min: latencies[0],
      max: latencies[latencies.length - 1],
      mean: sum / latencies.length,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
    };
  }

  private groupBridgeMetrics(): Record<string, { count: number; volume: bigint; fees: bigint }> {
    const grouped: Record<string, { count: number; volume: bigint; fees: bigint }> = {};

    for (const metric of this.bridgeMetrics) {
      const key = metric.bridge;
      if (!grouped[key]) {
        grouped[key] = { count: 0, volume: 0n, fees: 0n };
      }
      grouped[key].count++;
      grouped[key].volume += metric.amount;
      grouped[key].fees += metric.fee;
    }

    return grouped;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private async applyInitialBalances(balances: Record<string, bigint>): Promise<void> {
    // TODO: Adjust warp route balances to match specified initial balances
    // This may require minting/burning tokens
    this.logger?.info({ balances }, 'Applying initial balances');
  }
}

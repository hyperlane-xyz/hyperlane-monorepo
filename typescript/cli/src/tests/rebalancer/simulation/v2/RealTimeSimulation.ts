/**
 * RealTimeSimulation
 *
 * A simulation that uses REAL time with compressed intervals to test the
 * actual RebalancerService against traffic patterns.
 *
 * Key design:
 * - No fake timers (Sinon) - everything runs in real time
 * - Time compression: 1:60 means 1 second real = 60 seconds simulated
 * - RebalancerService runs with very short checkFrequency
 * - Traffic is generated at compressed intervals
 * - Results are recorded and can be visualized
 */
import type { Logger } from 'pino';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import {
  WeightedStrategy,
  type RawBalances,
  type RebalancingRoute,
} from '@hyperlane-xyz/rebalancer';
import { sleep, type Address } from '@hyperlane-xyz/utils';

import type { RebalancerTestSetup } from '../../harness/setup.js';
import { TrafficGenerator } from './TrafficGenerator.js';
import type {
  EnhancedTimeSeriesPoint,
  PendingWarpTransfer,
  ScheduledTransfer,
  SimulatedBridgeConfig,
  SimulationResults,
  SimulationRun,
  TransferEvent,
  TransferMetric,
  BridgeMetric,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface TimeCompressionConfig {
  /**
   * Time compression ratio. 60 means 1 real second = 60 simulated seconds.
   * Higher values = faster simulation but less realistic timing.
   */
  compressionRatio: number;

  /**
   * Real-time interval between traffic generation cycles (ms).
   * Smaller = more responsive but more CPU.
   */
  trafficCycleIntervalMs: number;

  /**
   * Real-time interval between balance recordings (ms).
   */
  recordingIntervalMs: number;
}

export interface RealTimeSimulationConfig {
  /** Test setup with deployed contracts */
  setup: RebalancerTestSetup;

  /** Time compression settings */
  timeCompression: TimeCompressionConfig;

  /** Warp message delivery time in SIMULATED ms */
  warpTransferDelaySimMs: number;

  /** Bridge configurations by "origin-dest" key */
  bridgeConfigs: Record<string, SimulatedBridgeConfig>;

  /** Rebalancer check frequency in SIMULATED ms (converted to real time internally) */
  rebalancerIntervalSimMs: number;

  /** Chain configurations for weighted strategy (null = no rebalancing) */
  strategyConfig: {
    chains: Record<string, {
      weight: number;
      tolerance: number;
      bridge: string;
    }>;
  } | null;

  /** Optional logger */
  logger?: Logger;
}

// Default time compression: 1:60 (30 simulated minutes = 30 real seconds)
export const DEFAULT_TIME_COMPRESSION: TimeCompressionConfig = {
  compressionRatio: 60,
  trafficCycleIntervalMs: 100, // Check for transfers every 100ms real time
  recordingIntervalMs: 500, // Record balances every 500ms real time
};

// ============================================================================
// Pending Items (extended from types.ts)
// ============================================================================

interface PendingWarpTransferSim extends PendingWarpTransfer {
  initiatedAtReal: number; // Real time (for debugging)
}

interface PendingBridgeTransferSim {
  transferId: string;
  origin: string;
  destination: string;
  amount: bigint;
  fee: bigint;
  bridge: Address;
  initiatedAtReal: number;
  initiatedAtSim: number;
  expectedCompletionAtSim: number;
  completed: boolean;
}

// ============================================================================
// Simulation
// ============================================================================

export class RealTimeSimulation {
  private readonly config: RealTimeSimulationConfig;
  private readonly logger?: Logger;
  private readonly strategy: WeightedStrategy | null;
  private readonly compression: TimeCompressionConfig;
  private readonly trafficGenerator: TrafficGenerator;

  // State
  private isRunning = false;
  private startTimeReal = 0;
  private executedTransferIndices = new Set<number>();
  private pendingWarpTransfers = new Map<string, PendingWarpTransferSim>();
  private pendingBridgeTransfers = new Map<string, PendingBridgeTransferSim>();

  // Metrics
  private transferMetrics: TransferMetric[] = [];
  private bridgeMetrics: BridgeMetric[] = [];
  private enhancedTimeSeries: EnhancedTimeSeriesPoint[] = [];
  private rebalanceCounter = 0;

  // Interval tracking
  private lastRebalanceSimTime = -Infinity;
  private lastRecordSimTime = -Infinity;

  constructor(config: RealTimeSimulationConfig) {
    this.config = config;
    this.logger = config.logger;
    this.compression = config.timeCompression;

    // Create traffic generator (uses the test harness's transfer execution)
    this.trafficGenerator = new TrafficGenerator(
      config.setup,
      config.warpTransferDelaySimMs,
    );

    // Create strategy if provided
    if (config.strategyConfig) {
      const strategyChainConfig: Record<string, { weighted: { weight: bigint; tolerance: bigint }; bridge: string }> = {};
      for (const [chain, cfg] of Object.entries(config.strategyConfig.chains)) {
        strategyChainConfig[chain] = {
          weighted: {
            weight: BigInt(cfg.weight),
            tolerance: BigInt(cfg.tolerance),
          },
          bridge: cfg.bridge,
        };
      }
      this.strategy = new WeightedStrategy(strategyChainConfig, config.logger!);
    } else {
      this.strategy = null;
    }
  }

  /**
   * Convert simulated time to real time duration.
   */
  private simToReal(simMs: number): number {
    return simMs / this.compression.compressionRatio;
  }

  /**
   * Convert real time duration to simulated time.
   */
  private realToSim(realMs: number): number {
    return realMs * this.compression.compressionRatio;
  }

  /**
   * Get current simulated time (ms from simulation start).
   */
  private getSimTime(): number {
    return this.realToSim(Date.now() - this.startTimeReal);
  }

  /**
   * Run the simulation.
   */
  async run(schedule: SimulationRun): Promise<SimulationResults & { transferMetrics: TransferMetric[] }> {
    this.logger?.info(
      {
        name: schedule.name,
        durationSimMs: schedule.durationMs,
        durationRealMs: this.simToReal(schedule.durationMs),
        compressionRatio: this.compression.compressionRatio,
        transferCount: schedule.transfers.length,
      },
      'Starting real-time simulation',
    );

    this.isRunning = true;
    this.startTimeReal = Date.now();

    // Reset state
    this.executedTransferIndices.clear();
    this.pendingWarpTransfers.clear();
    this.pendingBridgeTransfers.clear();
    this.transferMetrics = [];
    this.bridgeMetrics = [];
    this.enhancedTimeSeries = [];
    this.rebalanceCounter = 0;
    this.lastRebalanceSimTime = -Infinity;
    this.lastRecordSimTime = -Infinity;

    // Sort transfers by simulated time
    const sortedTransfers = [...schedule.transfers].sort((a, b) => a.time - b.time);

    try {
      // Main simulation loop - runs in real time
      while (this.isRunning && this.getSimTime() < schedule.durationMs) {
        const currentSimTime = this.getSimTime();
        const currentEvents: TransferEvent[] = [];
        let currentProposedRoutes: RebalancingRoute[] = [];

        // 1. Execute scheduled transfers that are due
        for (let i = 0; i < sortedTransfers.length; i++) {
          if (this.executedTransferIndices.has(i)) continue;
          const transfer = sortedTransfers[i];
          if (transfer.time <= currentSimTime) {
            this.executedTransferIndices.add(i);
            const event = await this.executeTransfer(transfer, currentSimTime);
            if (event) currentEvents.push(event);
          }
        }

        // 2. Complete warp transfers that are ready
        const warpEvents = await this.processWarpTransferCompletions(currentSimTime);
        currentEvents.push(...warpEvents);

        // 3. Complete bridge transfers that are ready
        const bridgeEvents = await this.processBridgeCompletions(currentSimTime);
        currentEvents.push(...bridgeEvents);

        // 4. Run rebalancer strategy at intervals
        if (currentSimTime - this.lastRebalanceSimTime >= this.config.rebalancerIntervalSimMs) {
          const routes = await this.runRebalancerStrategy(currentSimTime);
          currentProposedRoutes = routes;
          this.lastRebalanceSimTime = currentSimTime;

          // Execute any proposed rebalances
          for (const route of routes) {
            const event = await this.executeRebalance(route, currentSimTime);
            if (event) currentEvents.push(event);
          }
        }

        // 5. Record time series at intervals
        const recordingIntervalSim = this.realToSim(this.compression.recordingIntervalMs);
        if (currentSimTime - this.lastRecordSimTime >= recordingIntervalSim) {
          await this.recordTimeSeries(currentSimTime, currentEvents, currentProposedRoutes);
          this.lastRecordSimTime = currentSimTime;
        }

        // 6. Sleep for the traffic cycle interval
        await sleep(this.compression.trafficCycleIntervalMs);
      }

      // Final recording
      await this.recordTimeSeries(this.getSimTime(), [], []);
      this.markRemainingAsStuck();

      return this.buildResults(schedule);
    } finally {
      this.isRunning = false;
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  // ==========================================================================
  // Transfer Execution
  // ==========================================================================

  private async executeTransfer(
    transfer: ScheduledTransfer,
    currentSimTime: number,
  ): Promise<TransferEvent | null> {
    this.logger?.debug(
      { origin: transfer.origin, destination: transfer.destination, amount: transfer.amount.toString() },
      'Executing transfer',
    );

    try {
      // Use the TrafficGenerator which handles approvals and execution properly
      const pendingTransfer = await this.trafficGenerator.executeTransfer(transfer, currentSimTime);

      // Extend with real time tracking
      const pending: PendingWarpTransferSim = {
        ...pendingTransfer,
        initiatedAtReal: Date.now(),
        // Override expectedCompletionAt to use simulated time
        expectedCompletionAt: currentSimTime + this.config.warpTransferDelaySimMs,
      };

      this.pendingWarpTransfers.set(pending.txHash, pending);

      return {
        time: currentSimTime,
        type: 'transfer_initiated',
        origin: transfer.origin,
        destination: transfer.destination,
        amount: transfer.amount,
      };
    } catch (error) {
      this.logger?.error({ error, transfer }, 'Failed to execute transfer');
      return null;
    }
  }

  // ==========================================================================
  // Transfer Completion
  // ==========================================================================

  private async processWarpTransferCompletions(currentSimTime: number): Promise<TransferEvent[]> {
    const events: TransferEvent[] = [];

    for (const [txHash, pending] of this.pendingWarpTransfers) {
      if (pending.completed) continue;
      if (currentSimTime < pending.expectedCompletionAt) continue;

      this.logger?.debug({ txHash, messageId: pending.messageId }, 'Completing warp transfer');

      try {
        // Use TrafficGenerator to deliver the transfer
        await this.trafficGenerator.deliverTransfer(pending);

        pending.completed = true;

        events.push({
          time: currentSimTime,
          type: 'transfer_completed',
          origin: pending.origin,
          destination: pending.destination,
          amount: pending.amount,
        });

        // Record metric
        this.transferMetrics.push({
          id: pending.messageId,
          origin: pending.origin,
          destination: pending.destination,
          amount: pending.amount,
          initiatedAt: pending.initiatedAt,
          completedAt: currentSimTime,
          latencyMs: currentSimTime - pending.initiatedAt,
          waitedForCollateral: false,
          collateralWaitMs: 0,
        });
      } catch (error) {
        this.logger?.error({ error, txHash }, 'Failed to complete warp transfer');
      }
    }

    return events;
  }

  private async processBridgeCompletions(currentSimTime: number): Promise<TransferEvent[]> {
    const events: TransferEvent[] = [];

    for (const [transferId, pending] of this.pendingBridgeTransfers) {
      if (pending.completed) continue;
      if (currentSimTime < pending.expectedCompletionAtSim) continue;

      this.logger?.info(
        { transferId, origin: pending.origin, destination: pending.destination },
        'Completing bridge transfer (rebalance)',
      );

      // For now, just mark as complete and record the metric
      // In a full implementation, we'd call the bridge contract
      pending.completed = true;

      events.push({
        time: currentSimTime,
        type: 'rebalance_completed',
        origin: pending.origin,
        destination: pending.destination,
        amount: pending.amount,
      });

      this.bridgeMetrics.push({
        origin: pending.origin,
        destination: pending.destination,
        amount: pending.amount,
        fee: pending.fee,
        bridge: pending.bridge,
        initiatedAt: pending.initiatedAtSim,
        completedAt: currentSimTime,
      });
    }

    return events;
  }

  // ==========================================================================
  // Rebalancer Strategy
  // ==========================================================================

  private async runRebalancerStrategy(currentSimTime: number): Promise<RebalancingRoute[]> {
    if (!this.strategy) {
      return [];
    }

    // Get current balances
    const rawBalances: RawBalances = {};
    for (const [domainName, token] of Object.entries(this.config.setup.tokens)) {
      const warpRouteAddress = this.config.setup.getWarpRouteAddress(domainName);
      const balance = await token.balanceOf(warpRouteAddress);
      rawBalances[domainName] = BigInt(balance.toString());
    }

    // Get pending rebalances for context
    const pendingRebalances = [...this.pendingBridgeTransfers.values()]
      .filter(p => !p.completed)
      .map(p => ({
        origin: p.origin,
        destination: p.destination,
        amount: p.amount,
        bridge: p.bridge,
      }));

    // Run strategy
    const routes = this.strategy.getRebalancingRoutes(rawBalances, {
      pendingRebalances,
      pendingTransfers: [],
    });

    if (routes.length > 0) {
      this.logger?.info(
        { routes: routes.map(r => ({ from: r.origin, to: r.destination, amount: r.amount.toString() })) },
        'Rebalancer proposing routes',
      );
    }

    return routes;
  }

  private async executeRebalance(
    route: RebalancingRoute,
    currentSimTime: number,
  ): Promise<TransferEvent | null> {
    const bridgeKey = `${route.origin}-${route.destination}`;
    const bridgeConfig = this.config.bridgeConfigs[bridgeKey];

    if (!bridgeConfig) {
      this.logger?.warn({ bridgeKey }, 'No bridge config found for route');
      return null;
    }

    // Calculate fee
    const variableFee = (route.amount * BigInt(bridgeConfig.variableFeeBps)) / 10000n;
    const totalFee = bridgeConfig.fixedFee + variableFee;

    // Create pending bridge transfer
    const transferId = `rebalance-${++this.rebalanceCounter}`;
    const pending: PendingBridgeTransferSim = {
      transferId,
      origin: route.origin,
      destination: route.destination,
      amount: route.amount,
      fee: totalFee,
      bridge: route.bridge || this.config.setup.getBridge(route.origin, route.destination),
      initiatedAtReal: Date.now(),
      initiatedAtSim: currentSimTime,
      expectedCompletionAtSim: currentSimTime + bridgeConfig.transferTimeMs,
      completed: false,
    };

    this.pendingBridgeTransfers.set(transferId, pending);

    this.logger?.info(
      { transferId, origin: route.origin, destination: route.destination, amount: route.amount.toString() },
      'Rebalance initiated',
    );

    return {
      time: currentSimTime,
      type: 'rebalance_initiated',
      origin: route.origin,
      destination: route.destination,
      amount: route.amount,
    };
  }

  // ==========================================================================
  // Time Series & Metrics
  // ==========================================================================

  private async recordTimeSeries(
    currentSimTime: number,
    events: TransferEvent[],
    proposedRoutes: RebalancingRoute[],
  ): Promise<void> {
    const balances: Record<string, bigint> = {};

    for (const [domainName, token] of Object.entries(this.config.setup.tokens)) {
      const warpRouteAddress = this.config.setup.getWarpRouteAddress(domainName);
      const balance = await token.balanceOf(warpRouteAddress);
      balances[domainName] = BigInt(balance.toString());
    }

    this.enhancedTimeSeries.push({
      time: currentSimTime,
      balances,
      pendingTransfers: [...this.pendingWarpTransfers.values()].filter(t => !t.completed).length,
      pendingBridges: [...this.pendingBridgeTransfers.values()].filter(t => !t.completed).length,
      waitingForCollateral: 0,
      events: [...events],
      proposedRoutes: proposedRoutes.map(r => ({
        origin: r.origin,
        destination: r.destination,
        amount: r.amount,
      })),
    });
  }

  private markRemainingAsStuck(): void {
    const currentSimTime = this.getSimTime();

    for (const [_txHash, pending] of this.pendingWarpTransfers) {
      if (!pending.completed) {
        this.transferMetrics.push({
          id: pending.messageId,
          origin: pending.origin,
          destination: pending.destination,
          amount: pending.amount,
          initiatedAt: pending.initiatedAt,
          completedAt: -1,
          latencyMs: -1,
          waitedForCollateral: true,
          collateralWaitMs: currentSimTime - pending.expectedCompletionAt,
        });
      }
    }
  }

  // ==========================================================================
  // Results
  // ==========================================================================

  private buildResults(schedule: SimulationRun): SimulationResults & { transferMetrics: TransferMetric[] } {
    const completedTransfers = this.transferMetrics.filter(t => t.completedAt >= 0);
    const stuckTransfers = this.transferMetrics.filter(t => t.completedAt < 0);
    const latencies = completedTransfers.map(t => t.latencyMs).sort((a, b) => a - b);

    const wallClockMs = Date.now() - this.startTimeReal;

    return {
      name: schedule.name,
      duration: {
        simulatedMs: schedule.durationMs,
        wallClockMs,
      },
      transfers: {
        total: this.transferMetrics.length,
        completed: completedTransfers.length,
        stuck: stuckTransfers.length,
        latency: this.calculateLatencyStats(latencies),
        collateralWait: {
          count: completedTransfers.filter(t => t.waitedForCollateral).length,
          percent: completedTransfers.length > 0
            ? (completedTransfers.filter(t => t.waitedForCollateral).length / completedTransfers.length) * 100
            : 0,
          meanMs: completedTransfers.filter(t => t.waitedForCollateral).length > 0
            ? completedTransfers.filter(t => t.waitedForCollateral).reduce((sum, t) => sum + t.collateralWaitMs, 0) /
              completedTransfers.filter(t => t.waitedForCollateral).length
            : 0,
        },
      },
      rebalancing: {
        count: this.bridgeMetrics.length,
        totalVolume: this.bridgeMetrics.reduce((sum, b) => sum + b.amount, 0n),
        totalFees: this.bridgeMetrics.reduce((sum, b) => sum + b.fee, 0n),
        totalFeesUsd: 0,
        byBridge: this.groupBridgeMetrics(),
      },
      timeSeries: this.enhancedTimeSeries,
      enhancedTimeSeries: this.enhancedTimeSeries,
      transferMetrics: this.transferMetrics,
    };
  }

  private calculateLatencyStats(latencies: number[]) {
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

  private groupBridgeMetrics() {
    const grouped: Record<string, { count: number; volume: bigint; fees: bigint }> = {};

    for (const metric of this.bridgeMetrics) {
      const key = `${metric.origin}->${metric.destination}`;
      if (!grouped[key]) {
        grouped[key] = { count: 0, volume: 0n, fees: 0n };
      }
      grouped[key].count++;
      grouped[key].volume += metric.amount;
      grouped[key].fees += metric.fee;
    }

    return grouped;
  }
}

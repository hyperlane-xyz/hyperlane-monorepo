/**
 * RebalancerSimulation
 *
 * A comprehensive simulation that:
 * - Generates realistic traffic patterns
 * - Runs the rebalancer strategy at intervals
 * - Executes bridge transfers when strategy proposes routes
 * - Tracks all metrics and events for visualization
 * - Handles collateral deficits
 */
import type { Logger } from 'pino';

import {
  WeightedStrategy,
  type RawBalances,
  type RebalancingRoute,
} from '@hyperlane-xyz/rebalancer';
import type { Address } from '@hyperlane-xyz/utils';

import type { RebalancerTestSetup } from '../../harness/setup.js';
import { MockExplorerServer, createInflightMessage } from '../../harness/mock-explorer.js';
import { SimulationClock } from './SimulationClock.js';
import { TrafficGenerator } from './TrafficGenerator.js';
import type {
  BridgeMetric,
  EnhancedTimeSeriesPoint,
  PendingBridgeTransfer,
  PendingWarpTransfer,
  ScheduledTransfer,
  SimulatedBridgeConfig,
  SimulationResults,
  SimulationRun,
  TransferEvent,
  TransferMetric,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface RebalancerStrategyConfig {
  /** Chain configurations for weighted strategy */
  chains: Record<string, {
    weight: number;
    tolerance: number;
    bridge: string;
  }>;
}

export interface RebalancerSimulationConfig {
  /** Test setup with deployed contracts */
  setup: RebalancerTestSetup;

  /** Mock explorer server */
  explorerServer: MockExplorerServer;

  /** Warp transfer delay (time for Hyperlane message delivery) in ms */
  warpTransferDelayMs: number;

  /** Bridge configurations by "origin-dest" key */
  bridgeConfigs: Record<string, SimulatedBridgeConfig>;

  /** How often to run rebalancer check (in simulation time) */
  rebalancerIntervalMs: number;

  /** Time step for simulation (in ms) */
  timeStepMs: number;

  /** Rebalancer strategy configuration (null = no rebalancing) */
  strategyConfig: RebalancerStrategyConfig | null;

  /** Optional logger */
  logger?: Logger;
}

// ============================================================================
// Simulation
// ============================================================================

export class RebalancerSimulation {
  private readonly config: RebalancerSimulationConfig;
  private readonly clock: SimulationClock;
  private readonly trafficGenerator: TrafficGenerator;
  private readonly logger?: Logger;
  private readonly strategy: WeightedStrategy | null;

  // Pending items
  private pendingWarpTransfers: Map<string, PendingWarpTransfer> = new Map();
  private pendingBridgeTransfers: Map<string, PendingBridgeTransfer> = new Map();
  private executedTransferIndices: Set<number> = new Set();

  // Metrics
  private transferMetrics: TransferMetric[] = [];
  private bridgeMetrics: BridgeMetric[] = [];
  private enhancedTimeSeries: EnhancedTimeSeriesPoint[] = [];
  private currentEvents: TransferEvent[] = [];
  private currentProposedRoutes: RebalancingRoute[] = [];

  // State
  private isRunning = false;
  private wallClockStart = 0;
  private rebalanceCounter = 0;

  constructor(config: RebalancerSimulationConfig) {
    this.config = config;
    this.logger = config.logger;

    this.wallClockStart = performance.now();

    this.clock = new SimulationClock(config.setup.provider);
    this.trafficGenerator = new TrafficGenerator(
      config.setup,
      config.warpTransferDelayMs,
    );

    // Create strategy if config provided
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
   * Run the simulation.
   */
  async run(schedule: SimulationRun): Promise<SimulationResults> {
    this.logger?.info({ name: schedule.name }, 'Starting rebalancer simulation');
    this.wallClockStart = performance.now();
    this.isRunning = true;

    try {
      // Reset state
      this.pendingWarpTransfers.clear();
      this.pendingBridgeTransfers.clear();
      this.executedTransferIndices.clear();
      this.transferMetrics = [];
      this.bridgeMetrics = [];
      this.enhancedTimeSeries = [];
      this.rebalanceCounter = 0;

      // Sort transfers by time
      const sortedTransfers = [...schedule.transfers].sort((a, b) => a.time - b.time);

      // Recording intervals
      const timeSeriesInterval = Math.max(this.config.timeStepMs * 10, 1000);
      let lastTimeSeriesRecord = -timeSeriesInterval; // Record at t=0
      let lastRebalancerRun = -this.config.rebalancerIntervalMs; // Run at t=0

      // Main simulation loop
      while (this.clock.getElapsedTime() < schedule.durationMs && this.isRunning) {
        const currentTime = this.clock.getElapsedTime();
        this.currentEvents = [];
        this.currentProposedRoutes = [];

        // 1. Execute scheduled transfers
        for (let i = 0; i < sortedTransfers.length; i++) {
          if (this.executedTransferIndices.has(i)) continue;
          const transfer = sortedTransfers[i];
          if (transfer.time <= currentTime) {
            this.executedTransferIndices.add(i);
            await this.executeTransfer(transfer, currentTime);
          }
        }

        // 2. Complete warp transfers
        await this.processWarpTransferCompletions(currentTime);

        // 3. Complete bridge transfers (rebalancing)
        await this.processBridgeCompletions(currentTime);

        // 4. Run rebalancer strategy
        if (currentTime - lastRebalancerRun >= this.config.rebalancerIntervalMs) {
          await this.runRebalancerStrategy(currentTime);
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

      // Final recording
      await this.recordTimeSeries(this.clock.getElapsedTime());
      this.markRemainingAsStuck();

      return this.buildResults(schedule);
    } finally {
      this.isRunning = false;
      this.clock.restore();
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
    currentTime: number,
  ): Promise<void> {
    this.logger?.debug(
      { origin: transfer.origin, destination: transfer.destination, amount: transfer.amount.toString() },
      'Executing transfer',
    );

    try {
      const pending = await this.trafficGenerator.executeTransfer(transfer, currentTime);
      this.pendingWarpTransfers.set(pending.txHash, pending);

      // Record event
      this.currentEvents.push({
        time: currentTime,
        type: 'transfer_initiated',
        origin: transfer.origin,
        destination: transfer.destination,
        amount: transfer.amount,
      });

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

      this.logger?.debug({ txHash }, 'Completing warp transfer');

      try {
        await this.trafficGenerator.deliverTransfer(pending);
        pending.completed = true;

        // Record event
        this.currentEvents.push({
          time: currentTime,
          type: 'transfer_completed',
          origin: pending.origin,
          destination: pending.destination,
          amount: pending.amount,
        });

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
          waitedForCollateral: false,
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

      this.logger?.info(
        { transferId, origin: pending.origin, destination: pending.destination, amount: pending.amount.toString() },
        'Completing bridge transfer (rebalance)',
      );

      try {
        // Simulate the bridge transfer completing by moving tokens
        // In reality this would call completeTransfer on SimulatedTokenBridge
        // For now, we simulate the effect by recording the metric
        
        pending.completed = true;

        // Record event
        this.currentEvents.push({
          time: currentTime,
          type: 'rebalance_completed',
          origin: pending.origin,
          destination: pending.destination,
          amount: pending.amount,
        });

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
  // Rebalancer Strategy
  // ==========================================================================

  private async runRebalancerStrategy(currentTime: number): Promise<void> {
    if (!this.strategy) {
      return; // No rebalancing
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
        bridge: p.bridge as Address,
      }));

    // Run strategy
    const routes = this.strategy.getRebalancingRoutes(rawBalances, {
      pendingRebalances,
      pendingTransfers: [],
    });

    this.currentProposedRoutes = routes;

    if (routes.length > 0) {
      this.logger?.info(
        { routes: routes.map(r => ({ from: r.origin, to: r.destination, amount: r.amount.toString() })) },
        'Rebalancer proposing routes',
      );

      // Execute the rebalancing
      for (const route of routes) {
        await this.executeRebalance(route, currentTime);
      }
    }
  }

  private async executeRebalance(
    route: RebalancingRoute,
    currentTime: number,
  ): Promise<void> {
    const bridgeKey = `${route.origin}-${route.destination}`;
    const bridgeConfig = this.config.bridgeConfigs[bridgeKey];

    if (!bridgeConfig) {
      this.logger?.warn({ bridgeKey }, 'No bridge config found for route');
      return;
    }

    // Calculate fee
    const variableFee = (route.amount * BigInt(bridgeConfig.variableFeeBps)) / 10000n;
    const totalFee = bridgeConfig.fixedFee + variableFee;

    // Create pending bridge transfer
    const transferId = `rebalance-${++this.rebalanceCounter}`;
    const pending: PendingBridgeTransfer = {
      transferId,
      origin: route.origin,
      destination: route.destination,
      amount: route.amount,
      fee: totalFee,
      bridge: route.bridge || this.config.setup.getBridge(route.origin, route.destination),
      initiatedAt: currentTime,
      expectedCompletionAt: currentTime + bridgeConfig.transferTimeMs,
      completed: false,
    };

    this.pendingBridgeTransfers.set(transferId, pending);

    // Record event
    this.currentEvents.push({
      time: currentTime,
      type: 'rebalance_initiated',
      origin: route.origin,
      destination: route.destination,
      amount: route.amount,
    });

    this.logger?.info(
      { transferId, origin: route.origin, destination: route.destination, amount: route.amount.toString(), fee: totalFee.toString() },
      'Rebalance initiated',
    );
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

    this.enhancedTimeSeries.push({
      time: currentTime,
      balances,
      pendingTransfers: [...this.pendingWarpTransfers.values()].filter(t => !t.completed).length,
      pendingBridges: [...this.pendingBridgeTransfers.values()].filter(t => !t.completed).length,
      waitingForCollateral: 0,
      events: [...this.currentEvents],
      proposedRoutes: this.currentProposedRoutes.map(r => ({
        origin: r.origin,
        destination: r.destination,
        amount: r.amount,
      })),
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
          completedAt: -1,
          latencyMs: -1,
          waitedForCollateral: true,
          collateralWaitMs: currentTime - pending.expectedCompletionAt,
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
      // Include raw metrics for visualization
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

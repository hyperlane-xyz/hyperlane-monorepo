/**
 * FastSimulation
 *
 * A highly optimized simulation designed to handle dozens of transfers efficiently.
 *
 * Key optimizations:
 * - Pre-approves all tokens during initialization
 * - Caches gas quotes
 * - Batches transfer executions
 * - Uses wall-clock time (not simulated time) for scheduling
 * - Delivers messages in batches
 */
import type { Logger } from 'pino';

import {
  WeightedStrategy,
  type RawBalances,
  type RebalancingRoute,
} from '@hyperlane-xyz/rebalancer';
import { sleep, type Address } from '@hyperlane-xyz/utils';

import type { RebalancerTestSetup } from '../../harness/setup.js';
import { OptimizedTrafficGenerator } from './OptimizedTrafficGenerator.js';
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

export interface FastSimulationConfig {
  /** Test setup with deployed contracts */
  setup: RebalancerTestSetup;

  /** Message delivery delay in wall-clock milliseconds */
  messageDeliveryDelayMs: number;

  /** How often to check for pending deliveries (wall-clock ms) */
  deliveryCheckIntervalMs: number;

  /** How often to record balances (wall-clock ms) */
  recordingIntervalMs: number;

  /** How often to run rebalancer strategy (wall-clock ms) */
  rebalancerIntervalMs: number;

  /** Bridge configurations */
  bridgeConfigs: Record<string, SimulatedBridgeConfig>;

  /** Strategy configuration (null = no rebalancing) */
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

// ============================================================================
// Pending Items
// ============================================================================

interface PendingTransfer extends PendingWarpTransfer {
  deliveryDueAt: number; // Wall-clock time when delivery is due
}

interface PendingBridge {
  transferId: string;
  origin: string;
  destination: string;
  amount: bigint;
  fee: bigint;
  bridge: Address;
  initiatedAt: number;
  completionDueAt: number; // Wall-clock time
  completed: boolean;
}

// ============================================================================
// Simulation
// ============================================================================

export class FastSimulation {
  private readonly config: FastSimulationConfig;
  private readonly logger?: Logger;
  private readonly strategy: WeightedStrategy | null;
  private trafficGenerator!: OptimizedTrafficGenerator;

  // State
  private isRunning = false;
  private startTime = 0;
  private pendingTransfers = new Map<string, PendingTransfer>();
  private pendingBridges = new Map<string, PendingBridge>();
  private executedTransferIndices = new Set<number>();
  private isExecutingTransfers = false; // Lock to prevent concurrent transfer execution
  private isDeliveringTransfers = false; // Lock to prevent concurrent deliveries

  // Metrics
  private transferMetrics: TransferMetric[] = [];
  private bridgeMetrics: BridgeMetric[] = [];
  private timeSeries: EnhancedTimeSeriesPoint[] = [];
  private rebalanceCounter = 0;

  // Timing
  private lastDeliveryCheck = 0;
  private lastRecording = 0;
  private lastRebalancerRun = 0;

  constructor(config: FastSimulationConfig) {
    this.config = config;
    this.logger = config.logger;

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
   * Initialize the simulation (pre-approve tokens, cache quotes).
   */
  async initialize(): Promise<void> {
    this.logger?.info('Initializing FastSimulation...');
    
    this.trafficGenerator = new OptimizedTrafficGenerator(
      this.config.setup,
      this.config.messageDeliveryDelayMs,
    );

    await this.trafficGenerator.initialize();
    
    this.logger?.info('FastSimulation initialized');
  }

  /**
   * Get elapsed wall-clock time in ms.
   */
  private getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Run the simulation.
   */
  async run(schedule: SimulationRun): Promise<SimulationResults & { transferMetrics: TransferMetric[] }> {
    this.logger?.info(
      { name: schedule.name, transferCount: schedule.transfers.length },
      'Starting FastSimulation',
    );

    this.isRunning = true;
    this.startTime = Date.now();

    // Reset state
    this.pendingTransfers.clear();
    this.pendingBridges.clear();
    this.executedTransferIndices.clear();
    this.transferMetrics = [];
    this.bridgeMetrics = [];
    this.timeSeries = [];
    this.rebalanceCounter = 0;
    this.lastDeliveryCheck = 0;
    this.lastRecording = 0;
    this.lastRebalancerRun = 0;

    // Convert scheduled transfers to wall-clock schedule
    // We compress the simulation time to fit in the expected wall-clock duration
    const totalSimTime = schedule.durationMs;
    const expectedWallTime = Math.max(
      schedule.transfers.length * 500, // At least 500ms per transfer
      30_000, // At least 30 seconds
    );
    const timeScale = expectedWallTime / totalSimTime;

    const wallClockSchedule = schedule.transfers.map((t, idx) => ({
      ...t,
      wallClockTime: Math.round(t.time * timeScale),
      index: idx,
    })).sort((a, b) => a.wallClockTime - b.wallClockTime);

    this.logger?.info(
      { 
        simDurationMs: totalSimTime,
        expectedWallMs: expectedWallTime,
        timeScale,
      },
      'Time scaling configured',
    );

    try {
      // Initial recording
      await this.recordTimeSeries([]);

      // Main loop - runs until all scheduled transfers are executed and delivered
      // or we hit a timeout
      const maxWallTime = expectedWallTime * 3; // 3x expected time as safety margin
      
      while (this.isRunning) {
        const now = this.getElapsedTime();
        const events: TransferEvent[] = [];

        // Check timeout
        if (now > maxWallTime) {
          this.logger?.warn({ elapsed: now, max: maxWallTime }, 'Simulation timeout');
          break;
        }

        // 1. Execute scheduled transfers that are due (with lock to prevent concurrent execution)
        if (!this.isExecutingTransfers) {
          const dueTransfers = wallClockSchedule.filter(
            t => !this.executedTransferIndices.has(t.index) && t.wallClockTime <= now
          );

          if (dueTransfers.length > 0) {
            this.isExecutingTransfers = true;
            
            // Mark as "in progress" immediately to prevent re-scheduling
            for (const transfer of dueTransfers) {
              this.executedTransferIndices.add(transfer.index);
            }

            // Batch execute
            const batch = dueTransfers.map(t => ({
              transfer: t as ScheduledTransfer,
              currentTime: now,
            }));

            try {
              const results = await this.trafficGenerator.executeTransfersBatch(batch);
              
              for (let i = 0; i < results.length; i++) {
                const transfer = dueTransfers[i];
                const result = results[i];
                
                const pending: PendingTransfer = {
                  ...result,
                  deliveryDueAt: now + this.config.messageDeliveryDelayMs,
                };
                this.pendingTransfers.set(result.txHash, pending);

                events.push({
                  time: now,
                  type: 'transfer_initiated',
                  origin: transfer.origin,
                  destination: transfer.destination,
                  amount: transfer.amount,
                });
              }
            } catch (error: any) {
              this.logger?.error({ 
                error: error?.message || String(error),
                stack: error?.stack,
                reason: error?.reason,
              }, 'Batch transfer execution failed');
            } finally {
              this.isExecutingTransfers = false;
            }
          }
        }

        // 2. Process message deliveries (with lock to prevent concurrent delivery)
        if (!this.isDeliveringTransfers && now - this.lastDeliveryCheck >= this.config.deliveryCheckIntervalMs) {
          this.isDeliveringTransfers = true;
          try {
            const deliveryEvents = await this.processDeliveries(now);
            events.push(...deliveryEvents);
            this.lastDeliveryCheck = now;
          } finally {
            this.isDeliveringTransfers = false;
          }
        }

        // 3. Process bridge completions
        const bridgeEvents = this.processBridgeCompletions(now);
        events.push(...bridgeEvents);

        // 4. Run rebalancer
        if (now - this.lastRebalancerRun >= this.config.rebalancerIntervalMs) {
          const rebalanceEvents = await this.runRebalancer(now);
          events.push(...rebalanceEvents);
          this.lastRebalancerRun = now;
        }

        // 5. Record time series
        if (now - this.lastRecording >= this.config.recordingIntervalMs) {
          await this.recordTimeSeries(events);
          this.lastRecording = now;
        }

        // Check if we're done
        const allExecuted = this.executedTransferIndices.size >= schedule.transfers.length;
        const allDelivered = [...this.pendingTransfers.values()].every(t => t.completed);
        const allBridgesComplete = [...this.pendingBridges.values()].every(b => b.completed);

        if (allExecuted && allDelivered && allBridgesComplete) {
          this.logger?.info('All transfers completed');
          break;
        }

        // Small sleep to prevent busy loop
        await sleep(50);
      }

      // Final recording
      await this.recordTimeSeries([]);
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
  // Message Delivery
  // ==========================================================================

  private async processDeliveries(now: number): Promise<TransferEvent[]> {
    const events: TransferEvent[] = [];
    
    // Find transfers ready for delivery (not completed, due time passed, not already delivered)
    const readyForDelivery = [...this.pendingTransfers.values()].filter(
      t => !t.completed && 
           t.deliveryDueAt <= now && 
           !this.trafficGenerator.isDelivered(t.messageId)
    );

    if (readyForDelivery.length === 0) {
      return events;
    }

    this.logger?.debug({ count: readyForDelivery.length }, 'Delivering transfers');

    try {
      const result = await this.trafficGenerator.deliverTransfersBatch(readyForDelivery);
      
      this.logger?.debug(
        { delivered: result.delivered, skipped: result.skipped },
        'Delivery batch completed',
      );

      // Mark transfers as completed based on what was actually delivered
      for (const transfer of readyForDelivery) {
        // Check if it was delivered (either now or previously)
        if (this.trafficGenerator.isDelivered(transfer.messageId)) {
          transfer.completed = true;

          events.push({
            time: now,
            type: 'transfer_completed',
            origin: transfer.origin,
            destination: transfer.destination,
            amount: transfer.amount,
          });

          this.transferMetrics.push({
            id: transfer.messageId,
            origin: transfer.origin,
            destination: transfer.destination,
            amount: transfer.amount,
            initiatedAt: transfer.initiatedAt,
            completedAt: now,
            latencyMs: now - transfer.initiatedAt,
            waitedForCollateral: false,
            collateralWaitMs: 0,
          });
        }
      }
    } catch (error) {
      this.logger?.error({ error }, 'Batch delivery failed');
    }

    return events;
  }

  // ==========================================================================
  // Bridge Completions
  // ==========================================================================

  private processBridgeCompletions(now: number): TransferEvent[] {
    const events: TransferEvent[] = [];

    for (const [id, pending] of this.pendingBridges) {
      if (pending.completed) continue;
      if (pending.completionDueAt > now) continue;

      pending.completed = true;

      events.push({
        time: now,
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
        initiatedAt: pending.initiatedAt,
        completedAt: now,
      });
    }

    return events;
  }

  // ==========================================================================
  // Rebalancer
  // ==========================================================================

  private async runRebalancer(now: number): Promise<TransferEvent[]> {
    if (!this.strategy) return [];

    const events: TransferEvent[] = [];

    // Get current balances
    const rawBalances: RawBalances = {};
    for (const [domainName, token] of Object.entries(this.config.setup.tokens)) {
      const warpRouteAddress = this.config.setup.getWarpRouteAddress(domainName);
      const balance = await token.balanceOf(warpRouteAddress);
      rawBalances[domainName] = BigInt(balance.toString());
    }

    // Get pending rebalances
    const pendingRebalances = [...this.pendingBridges.values()]
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

      for (const route of routes) {
        const event = this.createRebalance(route, now);
        if (event) events.push(event);
      }
    }

    return events;
  }

  private createRebalance(route: RebalancingRoute, now: number): TransferEvent | null {
    const bridgeKey = `${route.origin}-${route.destination}`;
    const bridgeConfig = this.config.bridgeConfigs[bridgeKey];

    if (!bridgeConfig) {
      this.logger?.warn({ bridgeKey }, 'No bridge config found');
      return null;
    }

    const variableFee = (route.amount * BigInt(bridgeConfig.variableFeeBps)) / 10000n;
    const totalFee = bridgeConfig.fixedFee + variableFee;

    const transferId = `rebalance-${++this.rebalanceCounter}`;
    const pending: PendingBridge = {
      transferId,
      origin: route.origin,
      destination: route.destination,
      amount: route.amount,
      fee: totalFee,
      bridge: route.bridge || this.config.setup.getBridge(route.origin, route.destination),
      initiatedAt: now,
      completionDueAt: now + bridgeConfig.transferTimeMs,
      completed: false,
    };

    this.pendingBridges.set(transferId, pending);

    return {
      time: now,
      type: 'rebalance_initiated',
      origin: route.origin,
      destination: route.destination,
      amount: route.amount,
    };
  }

  // ==========================================================================
  // Recording
  // ==========================================================================

  private async recordTimeSeries(events: TransferEvent[]): Promise<void> {
    const now = this.getElapsedTime();
    const balances: Record<string, bigint> = {};

    for (const [domainName, token] of Object.entries(this.config.setup.tokens)) {
      const warpRouteAddress = this.config.setup.getWarpRouteAddress(domainName);
      const balance = await token.balanceOf(warpRouteAddress);
      balances[domainName] = BigInt(balance.toString());
    }

    this.timeSeries.push({
      time: now,
      balances,
      pendingTransfers: [...this.pendingTransfers.values()].filter(t => !t.completed).length,
      pendingBridges: [...this.pendingBridges.values()].filter(b => !b.completed).length,
      waitingForCollateral: 0,
      events: [...events],
      proposedRoutes: [],
    });
  }

  private markRemainingAsStuck(): void {
    const now = this.getElapsedTime();

    for (const [_txHash, pending] of this.pendingTransfers) {
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
          collateralWaitMs: now - pending.deliveryDueAt,
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

    const wallClockMs = this.getElapsedTime();

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
          meanMs: 0,
        },
      },
      rebalancing: {
        count: this.bridgeMetrics.length,
        totalVolume: this.bridgeMetrics.reduce((sum, b) => sum + b.amount, 0n),
        totalFees: this.bridgeMetrics.reduce((sum, b) => sum + b.fee, 0n),
        totalFeesUsd: 0,
        byBridge: this.groupBridgeMetrics(),
      },
      timeSeries: this.timeSeries,
      enhancedTimeSeries: this.timeSeries,
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

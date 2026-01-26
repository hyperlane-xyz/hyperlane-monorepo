/**
 * IntegratedSimulation
 *
 * An end-to-end simulation that runs the **real RebalancerService** against
 * simulated warp route traffic. The rebalancer doesn't know it's being simulated -
 * it interacts with real contracts on a local anvil instance.
 *
 * Key features:
 * - Uses real RebalancerService in daemon mode
 * - Traffic generator executes real warp route transfers
 * - Message delivery simulates Hyperlane relayer
 * - Bridge completion simulates external bridge finality
 * - MockExplorerServer provides inflight message tracking
 */
import type { Logger } from 'pino';

import { SimulatedTokenBridge__factory } from '@hyperlane-xyz/core';
import {
  RebalancerConfig,
  RebalancerService,
  type RebalancerServiceConfig,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '@hyperlane-xyz/rebalancer';
import { MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { sleep, type Address } from '@hyperlane-xyz/utils';

import {
  createMockMessageFromDispatch,
  MockExplorerServer,
} from '../../harness/mock-explorer.js';
import type { RebalancerTestSetup } from '../../harness/setup.js';
import { MockRegistry } from './MockRegistry.js';
import { OptimizedTrafficGenerator } from './OptimizedTrafficGenerator.js';
import type {
  BridgeMetric,
  EnhancedTimeSeriesPoint,
  PendingBridgeTransfer,
  PendingWarpTransfer,
  RouteDeliveryConfigs,
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

export interface IntegratedSimulationConfig {
  /** Test setup with deployed contracts */
  setup: RebalancerTestSetup;

  /** Warp route ID for registry lookups */
  warpRouteId: string;

  /** 
   * Message delivery delay in wall-clock milliseconds.
   * This is the default used when routeDeliveryConfigs is not specified.
   */
  messageDeliveryDelayMs: number;

  /**
   * Optional per-route delivery configurations.
   * Keys are "origin-destination" (e.g., "domain1-domain2").
   * If not specified for a route, messageDeliveryDelayMs is used.
   */
  routeDeliveryConfigs?: RouteDeliveryConfigs;

  /** How often to check for pending deliveries (wall-clock ms) */
  deliveryCheckIntervalMs: number;

  /** How often to record balances (wall-clock ms) */
  recordingIntervalMs: number;

  /** How often the rebalancer polls balances (wall-clock ms) */
  rebalancerCheckFrequencyMs: number;

  /** Bridge transfer completion delay (wall-clock ms) */
  bridgeTransferDelayMs: number;

  /** Bridge configurations (for fee calculation) */
  bridgeConfigs: Record<string, SimulatedBridgeConfig>;

  /** Strategy configuration for the rebalancer */
  strategyConfig: StrategyConfig[];

  /** Optional logger */
  logger?: Logger;

  /**
   * Enable mock explorer for inflight message tracking.
   * When enabled, the rebalancer's ActionTracker will see pending transfers.
   */
  enableMockExplorer?: boolean;
}

// ============================================================================
// Internal Types
// ============================================================================

interface PendingTransfer extends PendingWarpTransfer {
  deliveryDueAt: number;
  /** True if the transfer was initiated but delivery failed */
  deliveryFailed?: boolean;
  /** Number of delivery attempts */
  deliveryAttempts?: number;
}

interface PendingBridge extends PendingBridgeTransfer {
  completionDueAt: number;
}

// ============================================================================
// Simulation
// ============================================================================

export class IntegratedSimulation {
  private readonly config: IntegratedSimulationConfig;
  private readonly logger?: Logger;
  private trafficGenerator!: OptimizedTrafficGenerator;
  private rebalancerService!: RebalancerService;
  private mockRegistry!: MockRegistry;
  private mockExplorer?: MockExplorerServer;

  // State
  private isRunning = false;
  private startTime = 0;
  private pendingTransfers = new Map<string, PendingTransfer>();
  private pendingBridges = new Map<string, PendingBridge>();
  private executedTransferIndices = new Set<number>();
  private isExecutingTransfers = false;
  private isDeliveringTransfers = false;

  // Metrics
  private transferMetrics: TransferMetric[] = [];
  private bridgeMetrics: BridgeMetric[] = [];
  private timeSeries: EnhancedTimeSeriesPoint[] = [];

  // Timing
  private lastDeliveryCheck = 0;
  private lastRecording = 0;
  private lastBridgeCheck = 0;

  constructor(config: IntegratedSimulationConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  /**
   * Initialize the simulation (deploy contracts, create services).
   */
  async initialize(): Promise<void> {
    this.logger?.info('Initializing IntegratedSimulation...');

    // 1. Create MockRegistry from test setup
    this.mockRegistry = MockRegistry.fromSetup(
      this.config.setup,
      this.config.warpRouteId,
    );

    // 2. Create RebalancerConfig
    const rebalancerConfig = new RebalancerConfig(
      this.config.warpRouteId,
      this.config.strategyConfig,
    );

    // 3. Create MultiProvider and MultiProtocolProvider
    // Use per-chain rebalancer signers to avoid nonce conflicts during parallel execution
    const multiProvider = this.config.setup.getMultiProvider('rebalancer', true);
    const multiProtocolProvider =
      MultiProtocolProvider.fromMultiProvider(multiProvider);

    // 4. Create MockExplorerServer if enabled
    let explorerUrl: string | undefined;
    if (this.config.enableMockExplorer) {
      this.mockExplorer = await MockExplorerServer.create();
      explorerUrl = this.mockExplorer.getUrl();
      this.logger?.info({ explorerUrl }, 'MockExplorerServer started');
    }

    // 5. Create RebalancerService
    const serviceConfig: RebalancerServiceConfig = {
      mode: 'daemon',
      checkFrequency: this.config.rebalancerCheckFrequencyMs,
      monitorOnly: false, // We want real execution
      withMetrics: false, // No Prometheus for simulation
      logger: this.logger!,
      explorerUrl, // Use mock explorer if enabled
    };

    this.rebalancerService = new RebalancerService(
      multiProvider,
      multiProtocolProvider,
      this.mockRegistry,
      rebalancerConfig,
      serviceConfig,
    );

    // 6. Create traffic generator
    this.trafficGenerator = new OptimizedTrafficGenerator(
      this.config.setup,
      this.config.messageDeliveryDelayMs,
    );

    await this.trafficGenerator.initialize();

    this.logger?.info(
      { mockExplorerEnabled: !!this.mockExplorer },
      'IntegratedSimulation initialized',
    );
  }

  /**
   * Get elapsed wall-clock time in ms.
   */
  private getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Get the message delivery delay for a specific route.
   * Uses per-route config if available, otherwise falls back to default.
   */
  private getRouteDeliveryDelay(origin: string, destination: string): number {
    const routeKey = `${origin}-${destination}`;
    const routeConfig = this.config.routeDeliveryConfigs?.[routeKey];

    if (routeConfig) {
      const baseDelay = routeConfig.delayMs;
      const variance = routeConfig.varianceMs ?? 0;

      if (variance > 0) {
        // Add random variance: delay ± variance
        const randomVariance = (Math.random() * 2 - 1) * variance;
        return Math.max(0, baseDelay + randomVariance);
      }

      return baseDelay;
    }

    // Fall back to default
    return this.config.messageDeliveryDelayMs;
  }

  /**
   * Run the simulation.
   */
  async run(
    schedule: SimulationRun,
  ): Promise<SimulationResults & { transferMetrics: TransferMetric[] }> {
    this.logger?.info(
      { name: schedule.name, transferCount: schedule.transfers.length },
      'Starting IntegratedSimulation',
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
    this.lastDeliveryCheck = 0;
    this.lastRecording = 0;
    this.lastBridgeCheck = 0;

    // Calculate time scaling
    const totalSimTime = schedule.durationMs;
    const expectedWallTime = Math.max(
      schedule.transfers.length * 500,
      30_000,
    );
    const timeScale = expectedWallTime / totalSimTime;

    const wallClockSchedule = schedule.transfers
      .map((t, idx) => ({
        ...t,
        wallClockTime: Math.round(t.time * timeScale),
        index: idx,
      }))
      .sort((a, b) => a.wallClockTime - b.wallClockTime);

    this.logger?.info(
      {
        simDurationMs: totalSimTime,
        expectedWallMs: expectedWallTime,
        timeScale,
      },
      'Time scaling configured',
    );

    try {
      // Start the rebalancer service in daemon mode
      // Note: We run it in a separate "thread" (promise) and don't await it
      const rebalancerPromise = this.startRebalancerService();

      // Initial recording
      await this.recordTimeSeries([]);

      // Main loop
      const maxWallTime = expectedWallTime * 3;

      while (this.isRunning) {
        const now = this.getElapsedTime();
        const events: TransferEvent[] = [];

        // Check timeout
        if (now > maxWallTime) {
          this.logger?.warn({ elapsed: now, max: maxWallTime }, 'Simulation timeout');
          break;
        }

        // 1. Execute scheduled transfers
        if (!this.isExecutingTransfers) {
          const dueTransfers = wallClockSchedule.filter(
            (t) =>
              !this.executedTransferIndices.has(t.index) &&
              t.wallClockTime <= now,
          );

          if (dueTransfers.length > 0) {
            this.isExecutingTransfers = true;

            for (const transfer of dueTransfers) {
              this.executedTransferIndices.add(transfer.index);
            }

            const batch = dueTransfers.map((t) => ({
              transfer: t as ScheduledTransfer,
              currentTime: now,
            }));

            try {
              const results =
                await this.trafficGenerator.executeTransfersBatch(batch);

              for (let i = 0; i < results.length; i++) {
                const transfer = dueTransfers[i];
                const result = results[i];

                // Get delivery delay for this specific route
                const deliveryDelay = this.getRouteDeliveryDelay(
                  transfer.origin,
                  transfer.destination,
                );

                const pending: PendingTransfer = {
                  ...result,
                  deliveryDueAt: now + deliveryDelay,
                };
                this.pendingTransfers.set(result.txHash, pending);

                // Track in MockExplorer if enabled
                if (this.mockExplorer && result.messageBytes) {
                  this.trackTransferInMockExplorer(result, transfer);
                }

                events.push({
                  time: now,
                  type: 'transfer_initiated',
                  origin: transfer.origin,
                  destination: transfer.destination,
                  amount: transfer.amount,
                });
              }
            } catch (error: any) {
              this.logger?.error(
                {
                  error: error?.message || String(error),
                  stack: error?.stack,
                },
                'Batch transfer execution failed',
              );
            } finally {
              this.isExecutingTransfers = false;
            }
          }
        }

        // 2. Process message deliveries
        if (
          !this.isDeliveringTransfers &&
          now - this.lastDeliveryCheck >= this.config.deliveryCheckIntervalMs
        ) {
          this.isDeliveringTransfers = true;
          try {
            const deliveryEvents = await this.processDeliveries(now);
            events.push(...deliveryEvents);
            this.lastDeliveryCheck = now;
          } finally {
            this.isDeliveringTransfers = false;
          }
        }

        // 3. Process bridge completions (for rebalancer-initiated transfers)
        if (now - this.lastBridgeCheck >= 1000) {
          const bridgeEvents = await this.processBridgeCompletions(now);
          events.push(...bridgeEvents);
          this.lastBridgeCheck = now;
        }

        // 4. Record time series
        if (now - this.lastRecording >= this.config.recordingIntervalMs) {
          await this.recordTimeSeries(events);
          this.lastRecording = now;
        }

        // Check if we're done
        const allExecuted =
          this.executedTransferIndices.size >= schedule.transfers.length;
        const allDelivered = [...this.pendingTransfers.values()].every(
          (t) => t.completed,
        );
        const allBridgesComplete = [...this.pendingBridges.values()].every(
          (b) => b.completed,
        );

        if (allExecuted && allDelivered && allBridgesComplete) {
          this.logger?.info('All transfers completed');
          break;
        }

        await sleep(50);
      }

      // Stop the rebalancer service
      await this.rebalancerService.stop();

      // Wait for the rebalancer promise to settle
      try {
        await Promise.race([
          rebalancerPromise,
          sleep(1000), // Give it 1 second to shut down gracefully
        ]);
      } catch (error) {
        // Ignore shutdown errors
      }

      // Final recording
      await this.recordTimeSeries([]);
      this.markRemainingAsStuck();

      return this.buildResults(schedule);
    } finally {
      this.isRunning = false;
      // Cleanup MockExplorer if it was created
      await this.cleanup();
    }
  }

  /**
   * Start the rebalancer service in daemon mode.
   * This runs in the background and will be stopped when the simulation ends.
   */
  private async startRebalancerService(): Promise<void> {
    try {
      await this.rebalancerService.start();
    } catch (error: any) {
      // The service will throw when stop() is called, which is expected
      if (!error.message?.includes('shutdown')) {
        this.logger?.error({ error }, 'RebalancerService error');
      }
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

    const readyForDelivery = [...this.pendingTransfers.values()].filter(
      (t) =>
        !t.completed &&
        !t.deliveryFailed &&
        t.deliveryDueAt <= now &&
        !this.trafficGenerator.isDelivered(t.messageId),
    );

    if (readyForDelivery.length === 0) {
      return events;
    }

    this.logger?.debug({ count: readyForDelivery.length }, 'Delivering transfers');

    const result =
      await this.trafficGenerator.deliverTransfersBatch(readyForDelivery);

    this.logger?.debug(
      { delivered: result.delivered, skipped: result.skipped, failed: result.failed },
      'Delivery batch completed',
    );

    // Process results per-transfer
    for (const transfer of readyForDelivery) {
      const deliveryResult = result.results.find(r => r.messageId === transfer.messageId);
      
      if (deliveryResult?.success && this.trafficGenerator.isDelivered(transfer.messageId)) {
        // Successfully delivered
        transfer.completed = true;

        // Mark as delivered in MockExplorer
        if (this.mockExplorer) {
          this.mockExplorer.markDelivered(transfer.messageId);
        }

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
      } else if (deliveryResult && !deliveryResult.success) {
        // Delivery failed (e.g., insufficient collateral)
        transfer.deliveryAttempts = (transfer.deliveryAttempts || 0) + 1;
        
        this.logger?.warn(
          { 
            messageId: transfer.messageId, 
            error: deliveryResult.error,
            attempts: transfer.deliveryAttempts,
          },
          'Transfer delivery failed',
        );
        
        // After 3 attempts, mark as permanently failed
        if (transfer.deliveryAttempts >= 3) {
          transfer.deliveryFailed = true;
          this.logger?.error(
            { messageId: transfer.messageId },
            'Transfer marked as permanently failed after 3 attempts',
          );
        }
      }
    }

    return events;
  }

  // ==========================================================================
  // Bridge Completions
  // ==========================================================================

  /**
   * Process bridge completions by querying the SimulatedTokenBridge contracts
   * for pending transfers and completing them after the delay.
   */
  private async processBridgeCompletions(now: number): Promise<TransferEvent[]> {
    const events: TransferEvent[] = [];
    const { setup } = this.config;

    // Get all collateral domain names
    const collateralDomains = Object.keys(setup.tokens);

    for (const origin of collateralDomains) {
      for (const dest of collateralDomains) {
        if (origin === dest) continue;

        const bridgeKey = `${origin}-${dest}`;
        const bridgeAddress = setup.bridges[bridgeKey];
        if (!bridgeAddress) continue;

        const bridge = SimulatedTokenBridge__factory.connect(
          bridgeAddress,
          setup.signers.bridge,
        );

        try {
          // Get pending transfer IDs from the bridge
          const pendingIds = await bridge.getPendingTransferIds();

          for (const transferId of pendingIds) {
            const transferIdStr = transferId.toString();

            // Check if we're already tracking this
            let pending = this.pendingBridges.get(transferIdStr);
            if (!pending) {
              // Get transfer details
              const transfer = await bridge.getTransfer(transferId);

              pending = {
                transferId: transferIdStr,
                origin,
                destination: dest,
                amount: BigInt(transfer.amount.toString()),
                fee: BigInt(transfer.fee.toString()),
                bridge: bridgeAddress,
                initiatedAt: now,
                expectedCompletionAt: now + this.config.bridgeTransferDelayMs,
                completionDueAt: now + this.config.bridgeTransferDelayMs,
                completed: false,
              };

              this.pendingBridges.set(transferIdStr, pending);

              events.push({
                time: now,
                type: 'rebalance_initiated',
                origin,
                destination: dest,
                amount: pending.amount,
              });

              this.logger?.info(
                {
                  transferId: transferIdStr,
                  origin,
                  destination: dest,
                  amount: pending.amount.toString(),
                },
                'Detected bridge transfer from rebalancer',
              );
            }

            // Check if it's time to complete
            if (!pending.completed && pending.completionDueAt <= now) {
              // Get the recipient address from transfer details
              const transfer = await bridge.getTransfer(transferId);
              const recipientBytes32 = transfer.recipient;

              // Convert bytes32 to address (take last 20 bytes)
              const recipientAddress =
                '0x' + recipientBytes32.slice(-40) as Address;

              // Complete the transfer
              try {
                await (
                  await bridge.completeTransfer(transferId, recipientAddress)
                ).wait();

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

                this.logger?.info(
                  {
                    transferId: transferIdStr,
                    origin: pending.origin,
                    destination: pending.destination,
                    amount: pending.amount.toString(),
                  },
                  'Completed bridge transfer',
                );
              } catch (error: any) {
                this.logger?.error(
                  {
                    transferId: transferIdStr,
                    error: error?.message || String(error),
                  },
                  'Failed to complete bridge transfer',
                );
              }
            }
          }
        } catch (error: any) {
          // Ignore errors from querying bridges (might not have any transfers)
          this.logger?.debug(
            { bridge: bridgeKey, error: error?.message },
            'Error querying bridge',
          );
        }
      }
    }

    return events;
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
      pendingTransfers: [...this.pendingTransfers.values()].filter(
        (t) => !t.completed,
      ).length,
      pendingBridges: [...this.pendingBridges.values()].filter(
        (b) => !b.completed,
      ).length,
      waitingForCollateral: 0,
      events: [...events],
      proposedRoutes: [],
    });
  }

  private markRemainingAsStuck(): void {
    const now = this.getElapsedTime();

    for (const [_txHash, pending] of this.pendingTransfers) {
      // Mark as stuck if: not completed OR delivery permanently failed
      if (!pending.completed || pending.deliveryFailed) {
        // Don't double-count if already in metrics (from deliveryFailed path)
        const alreadyInMetrics = this.transferMetrics.some(
          (m) => m.id === pending.messageId,
        );
        if (!alreadyInMetrics) {
          this.logger?.debug(
            { 
              messageId: pending.messageId, 
              deliveryFailed: pending.deliveryFailed,
              attempts: pending.deliveryAttempts,
            },
            'Marking transfer as stuck',
          );
          
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
  }

  // ==========================================================================
  // Results
  // ==========================================================================

  private buildResults(
    schedule: SimulationRun,
  ): SimulationResults & { transferMetrics: TransferMetric[] } {
    const completedTransfers = this.transferMetrics.filter(
      (t) => t.completedAt >= 0,
    );
    const stuckTransfers = this.transferMetrics.filter((t) => t.completedAt < 0);
    const latencies = completedTransfers
      .map((t) => t.latencyMs)
      .sort((a, b) => a - b);

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
          count: completedTransfers.filter((t) => t.waitedForCollateral).length,
          percent:
            completedTransfers.length > 0
              ? (completedTransfers.filter((t) => t.waitedForCollateral).length /
                  completedTransfers.length) *
                100
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
    const grouped: Record<
      string,
      { count: number; volume: bigint; fees: bigint }
    > = {};

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

  // ==========================================================================
  // Mock Explorer Integration
  // ==========================================================================

  /**
   * Track a user transfer in the MockExplorer.
   * This allows the rebalancer's ActionTracker to see pending transfers.
   */
  private trackTransferInMockExplorer(
    result: PendingWarpTransfer,
    transfer: ScheduledTransfer,
  ): void {
    if (!this.mockExplorer || !result.messageBytes) return;

    const { setup } = this.config;

    // Get domain IDs
    const originDomain = setup.getDomain(transfer.origin);
    const destDomain = setup.getDomain(transfer.destination);

    // Get router addresses (warp route addresses)
    const originRouter = setup.getWarpRouteAddress(transfer.origin);
    const destRouter = setup.getWarpRouteAddress(transfer.destination);

    // Extract the message body from the full Hyperlane message.
    // Hyperlane message format:
    //   version: 1 byte
    //   nonce: 4 bytes
    //   origin: 4 bytes
    //   sender: 32 bytes
    //   destination: 4 bytes
    //   recipient: 32 bytes
    //   body: remaining bytes (starts at offset 77)
    // The body is what parseWarpRouteMessage expects (recipient + amount)
    const BODY_OFFSET = 77;
    const messageBody = '0x' + result.messageBytes.slice(2 + BODY_OFFSET * 2);

    this.mockExplorer.addMessage(
      createMockMessageFromDispatch({
        messageId: result.messageId,
        originDomainId: originDomain.domainId,
        destinationDomainId: destDomain.domainId,
        sender: originRouter as Address,
        recipient: destRouter as Address,
        originTxHash: result.txHash,
        originTxSender: result.sender,
        originTxRecipient: originRouter as Address,
        messageBody,
      }),
    );

    this.logger?.debug(
      {
        messageId: result.messageId,
        origin: transfer.origin,
        destination: transfer.destination,
        amount: transfer.amount.toString(),
      },
      'Tracked transfer in MockExplorer',
    );
  }

  /**
   * Cleanup method to close the MockExplorer server.
   */
  async cleanup(): Promise<void> {
    if (this.mockExplorer) {
      await this.mockExplorer.close();
      this.logger?.info('MockExplorerServer closed');
    }
  }
}

// ============================================================================
// Helper to create strategy config from test setup
// ============================================================================

/**
 * Create a weighted strategy config from test setup.
 * 
 * For multi-chain scenarios (3+ collateral domains), this function uses the
 * `override` field to specify per-destination bridges, ensuring the rebalancer
 * can route to any destination.
 */
export function createWeightedStrategyConfig(
  setup: RebalancerTestSetup,
  weights: Record<string, { weight: number; tolerance: number }>,
): StrategyConfig[] {
  const chains: Record<
    string,
    {
      bridge: string;
      override?: Record<string, { bridge: string }>;
      weighted: { weight: bigint; tolerance: bigint };
    }
  > = {};

  const collateralDomains = Object.keys(setup.tokens);

  for (const domain of collateralDomains) {
    const config = weights[domain];
    if (!config) continue;

    // Find the first bridge from this domain (default bridge)
    let defaultBridge = '';
    const overrides: Record<string, { bridge: string }> = {};
    
    for (const otherDomain of collateralDomains) {
      if (otherDomain === domain) continue;
      
      const bridgeKey = `${domain}-${otherDomain}`;
      const bridge = setup.bridges[bridgeKey];
      
      if (bridge) {
        if (!defaultBridge) {
          defaultBridge = bridge;
        } else {
          // For additional destinations, add to overrides
          overrides[otherDomain] = { bridge };
        }
      }
    }

    chains[domain] = {
      bridge: defaultBridge,
      ...(Object.keys(overrides).length > 0 && { override: overrides }),
      weighted: {
        weight: BigInt(config.weight),
        tolerance: BigInt(config.tolerance),
      },
    };
  }

  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chains,
    },
  ];
}

import type { ethers } from 'ethers';

import { ERC20Test__factory } from '@hyperlane-xyz/core';

import type { DeployedDomain } from '../deployment/types.js';

import type {
  ChainMetrics,
  RebalanceRecord,
  SimulationKPIs,
  StateSnapshot,
  TransferRecord,
} from './types.js';

/**
 * KPICollector tracks metrics throughout a simulation run.
 */
export class KPICollector {
  private transferRecords: Map<string, TransferRecord> = new Map();
  private rebalanceRecords: Map<string, RebalanceRecord> = new Map();
  /** Maps bridge transfer ID to rebalance ID for correlation */
  private bridgeToRebalanceMap: Map<string, string> = new Map();
  private timeline: StateSnapshot[] = [];
  private initialBalances: Record<string, bigint> = {};
  private snapshotInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly provider: ethers.providers.JsonRpcProvider,
    private readonly domains: Record<string, DeployedDomain>,
    private readonly snapshotFrequencyMs: number = 1000,
  ) {}

  /**
   * Initialize with initial balances
   */
  async initialize(): Promise<void> {
    for (const chainName of Object.keys(this.domains)) {
      this.initialBalances[chainName] = await this.getBalance(chainName);
    }

    // Take initial snapshot
    await this.takeSnapshot();
  }

  /**
   * Start periodic snapshot collection
   */
  startSnapshotCollection(): void {
    if (this.snapshotInterval) return;

    this.snapshotInterval = setInterval(async () => {
      await this.takeSnapshot();
    }, this.snapshotFrequencyMs);
  }

  /**
   * Stop snapshot collection
   */
  stopSnapshotCollection(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
  }

  /**
   * Get current balance for a chain's warp token
   */
  private async getBalance(chainName: string): Promise<bigint> {
    const domain = this.domains[chainName];
    const token = ERC20Test__factory.connect(
      domain.collateralToken,
      this.provider,
    );
    const balance = await token.balanceOf(domain.warpToken);
    return balance.toBigInt();
  }

  /**
   * Take a state snapshot
   */
  async takeSnapshot(): Promise<StateSnapshot> {
    const balances: Record<string, bigint> = {};
    for (const chainName of Object.keys(this.domains)) {
      balances[chainName] = await this.getBalance(chainName);
    }

    const pendingTransfers = Array.from(this.transferRecords.values()).filter(
      (t) => t.status === 'pending',
    ).length;

    const pendingRebalances = this.getPendingRebalancesCount();

    const snapshot: StateSnapshot = {
      timestamp: Date.now(),
      balances,
      pendingTransfers,
      pendingRebalances,
    };

    this.timeline.push(snapshot);
    return snapshot;
  }

  /**
   * Record transfer start
   */
  recordTransferStart(
    id: string,
    origin: string,
    destination: string,
    amount: bigint,
  ): void {
    this.transferRecords.set(id, {
      id,
      origin,
      destination,
      amount,
      startTime: Date.now(),
      status: 'pending',
    });
  }

  /**
   * Record transfer completion
   */
  recordTransferComplete(id: string): void {
    const record = this.transferRecords.get(id);
    if (record) {
      record.endTime = Date.now();
      record.latency = record.endTime - record.startTime;
      record.status = 'completed';
    }
  }

  /**
   * Record transfer failure
   */
  recordTransferFailed(id: string): void {
    const record = this.transferRecords.get(id);
    if (record) {
      record.endTime = Date.now();
      record.status = 'failed';
    }
  }

  /**
   * Mark all pending transfers as complete (used after mailbox processing)
   */
  markAllPendingAsComplete(): void {
    const now = Date.now();
    for (const record of this.transferRecords.values()) {
      if (record.status === 'pending') {
        record.endTime = now;
        record.latency = now - record.startTime;
        record.status = 'completed';
      }
    }
  }

  /**
   * Record a rebalance operation start (when SentTransferRemote fires)
   * Returns the rebalance ID for correlation
   */
  recordRebalanceStart(
    origin: string,
    destination: string,
    amount: bigint,
    gasCost: bigint,
  ): string {
    const id = `rebalance-${this.rebalanceRecords.size}`;
    this.rebalanceRecords.set(id, {
      id,
      origin,
      destination,
      amount,
      startTime: Date.now(),
      gasCost,
      status: 'pending',
    });
    return id;
  }

  /**
   * Link a bridge transfer ID to a rebalance ID for delivery tracking
   */
  linkBridgeTransfer(bridgeTransferId: string, rebalanceId: string): void {
    this.bridgeToRebalanceMap.set(bridgeTransferId, rebalanceId);
    const record = this.rebalanceRecords.get(rebalanceId);
    if (record) {
      record.bridgeTransferId = bridgeTransferId;
    }
  }

  /**
   * Record rebalance completion (when bridge delivers)
   */
  recordRebalanceComplete(bridgeTransferId: string): void {
    const rebalanceId = this.bridgeToRebalanceMap.get(bridgeTransferId);
    if (!rebalanceId) return;

    const record = this.rebalanceRecords.get(rebalanceId);
    if (record && record.status === 'pending') {
      record.endTime = Date.now();
      record.latency = record.endTime - record.startTime;
      record.status = 'completed';
    }
  }

  /**
   * Record rebalance failure
   */
  recordRebalanceFailed(bridgeTransferId: string): void {
    const rebalanceId = this.bridgeToRebalanceMap.get(bridgeTransferId);
    if (!rebalanceId) return;

    const record = this.rebalanceRecords.get(rebalanceId);
    if (record) {
      record.endTime = Date.now();
      record.status = 'failed';
    }
  }

  /**
   * Get pending rebalances count
   */
  getPendingRebalancesCount(): number {
    return Array.from(this.rebalanceRecords.values()).filter(
      (r) => r.status === 'pending',
    ).length;
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Generate final KPIs
   */
  async generateKPIs(): Promise<SimulationKPIs> {
    const transfers = Array.from(this.transferRecords.values());
    const completed = transfers.filter((t) => t.status === 'completed');
    const failed = transfers.filter((t) => t.status === 'failed');

    // Calculate latencies
    const latencies = completed
      .filter((t) => t.latency !== undefined)
      .map((t) => t.latency!)
      .sort((a, b) => a - b);

    const avgLatency =
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

    // Calculate per-chain metrics
    const perChainMetrics: Record<string, ChainMetrics> = {};
    for (const chainName of Object.keys(this.domains)) {
      const transfersIn = transfers.filter(
        (t) => t.destination === chainName && t.status === 'completed',
      ).length;
      const transfersOut = transfers.filter(
        (t) => t.origin === chainName && t.status === 'completed',
      ).length;

      const allRebalances = Array.from(this.rebalanceRecords.values());
      const rebalancesIn = allRebalances.filter(
        (r) => r.destination === chainName && r.status === 'completed',
      ).length;
      const rebalancesOut = allRebalances.filter(
        (r) => r.origin === chainName && r.status === 'completed',
      ).length;

      const rebalanceVolumeIn = allRebalances
        .filter((r) => r.destination === chainName && r.status === 'completed')
        .reduce((sum, r) => sum + r.amount, BigInt(0));
      const rebalanceVolumeOut = allRebalances
        .filter((r) => r.origin === chainName && r.status === 'completed')
        .reduce((sum, r) => sum + r.amount, BigInt(0));

      const finalBalance = await this.getBalance(chainName);

      perChainMetrics[chainName] = {
        chainName,
        initialBalance: this.initialBalances[chainName] ?? BigInt(0),
        finalBalance,
        transfersIn,
        transfersOut,
        rebalancesIn,
        rebalancesOut,
        rebalanceVolumeIn,
        rebalanceVolumeOut,
      };
    }

    // Calculate rebalance totals
    const allRebalanceRecords = Array.from(this.rebalanceRecords.values());
    const completedRebalances = allRebalanceRecords.filter(
      (r) => r.status === 'completed',
    );
    const totalRebalanceVolume = completedRebalances.reduce(
      (sum, r) => sum + r.amount,
      BigInt(0),
    );
    const totalGasCost = completedRebalances.reduce(
      (sum, r) => sum + r.gasCost,
      BigInt(0),
    );

    return {
      totalTransfers: transfers.length,
      completedTransfers: completed.length,
      failedTransfers: failed.length,
      completionRate:
        transfers.length > 0 ? completed.length / transfers.length : 1,
      averageLatency: avgLatency,
      p50Latency: this.percentile(latencies, 50),
      p95Latency: this.percentile(latencies, 95),
      p99Latency: this.percentile(latencies, 99),
      totalRebalances: completedRebalances.length,
      rebalanceVolume: totalRebalanceVolume,
      totalGasCost,
      perChainMetrics,
    };
  }

  /**
   * Get timeline snapshots
   */
  getTimeline(): StateSnapshot[] {
    return [...this.timeline];
  }

  /**
   * Get transfer records
   */
  getTransferRecords(): TransferRecord[] {
    return Array.from(this.transferRecords.values());
  }

  /**
   * Get rebalance records
   */
  getRebalanceRecords(): RebalanceRecord[] {
    return Array.from(this.rebalanceRecords.values());
  }

  /**
   * Reset collector for new simulation
   */
  reset(): void {
    this.transferRecords.clear();
    this.rebalanceRecords.clear();
    this.bridgeToRebalanceMap.clear();
    this.timeline = [];
    this.initialBalances = {};
    this.stopSnapshotCollection();
  }
}

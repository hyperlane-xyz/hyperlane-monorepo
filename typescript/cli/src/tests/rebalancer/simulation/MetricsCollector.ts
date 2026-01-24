/**
 * MetricsCollector
 *
 * Collects and calculates metrics from simulation runs.
 */
import type {
  LatencyStats,
  PendingRebalance,
  PendingTransfer,
  RebalancingMetrics,
  SimulationResults,
  SimulationScores,
  TimeSeriesPoint,
  TransferMetrics,
} from './types.js';

/**
 * Collects metrics during simulation and calculates final scores.
 */
export class MetricsCollector {
  private completedTransfers: PendingTransfer[] = [];
  private stuckTransfers: PendingTransfer[] = [];
  private completedRebalances: PendingRebalance[] = [];
  private failedRebalances: PendingRebalance[] = [];
  private timeSeries: TimeSeriesPoint[] = [];

  private startWallClock: number = 0;
  private simulatedDurationMs: number = 0;
  private warpTransferLatencyMs: number = 0;

  /**
   * Initialize the collector.
   */
  initialize(warpTransferLatencyMs: number): void {
    this.completedTransfers = [];
    this.stuckTransfers = [];
    this.completedRebalances = [];
    this.failedRebalances = [];
    this.timeSeries = [];
    this.startWallClock = Date.now();
    this.warpTransferLatencyMs = warpTransferLatencyMs;
  }

  /**
   * Record a completed transfer.
   */
  recordCompletedTransfer(transfer: PendingTransfer): void {
    this.completedTransfers.push(transfer);
  }

  /**
   * Record a stuck transfer.
   */
  recordStuckTransfer(transfer: PendingTransfer): void {
    this.stuckTransfers.push(transfer);
  }

  /**
   * Record a completed rebalance.
   */
  recordCompletedRebalance(rebalance: PendingRebalance): void {
    this.completedRebalances.push(rebalance);
  }

  /**
   * Record a failed rebalance.
   */
  recordFailedRebalance(rebalance: PendingRebalance): void {
    this.failedRebalances.push(rebalance);
  }

  /**
   * Record a time series point.
   */
  recordTimeSeriesPoint(point: TimeSeriesPoint): void {
    this.timeSeries.push(point);
  }

  /**
   * Finalize and calculate all metrics.
   */
  finalize(simulatedDurationMs: number): SimulationResults {
    this.simulatedDurationMs = simulatedDurationMs;
    const wallClockMs = Date.now() - this.startWallClock;

    const transfers = this.calculateTransferMetrics();
    const rebalancing = this.calculateRebalancingMetrics();
    const scores = this.calculateScores(transfers, rebalancing);

    return {
      duration: {
        simulatedMs: simulatedDurationMs,
        wallClockMs,
      },
      transfers,
      rebalancing,
      timeSeries: this.timeSeries,
      scores,
    };
  }

  /**
   * Calculate transfer metrics.
   */
  private calculateTransferMetrics(): TransferMetrics {
    const total = this.completedTransfers.length + this.stuckTransfers.length;
    const completed = this.completedTransfers.length;
    const stuck = this.stuckTransfers.length;

    // Calculate latencies for completed transfers
    const latencies = this.completedTransfers.map((t) => {
      const completedAt = t.completedAt ?? t.arrivalTime;
      return completedAt - t.transfer.timestamp;
    });

    const latency = this.calculateLatencyStats(latencies);

    // Calculate collateral wait times
    // (time spent waiting for collateral beyond normal warp latency)
    const waitTimes = this.completedTransfers
      .filter((t) => t.collateralAvailableAt !== undefined)
      .map((t) => {
        const waitStart = t.arrivalTime;
        const waitEnd = t.collateralAvailableAt!;
        return Math.max(0, waitEnd - waitStart);
      });

    const affectedCount = waitTimes.filter((w) => w > 0).length;

    return {
      total,
      completed,
      stuck,
      latency,
      collateralWaitTime: {
        mean: waitTimes.length > 0 ? this.mean(waitTimes) : 0,
        p95: waitTimes.length > 0 ? this.percentile(waitTimes, 95) : 0,
        affectedCount,
        affectedPercent: total > 0 ? (affectedCount / total) * 100 : 0,
      },
    };
  }

  /**
   * Calculate rebalancing metrics.
   */
  private calculateRebalancingMetrics(): RebalancingMetrics {
    const initiated =
      this.completedRebalances.length + this.failedRebalances.length;
    const completed = this.completedRebalances.length;
    const failed = this.failedRebalances.length;

    // Volume
    const totalVolume = this.completedRebalances.reduce(
      (sum, r) => sum + r.route.amount,
      0n,
    );
    const totalTransfers =
      this.completedTransfers.length + this.stuckTransfers.length;
    const perTransfer =
      totalTransfers > 0 ? totalVolume / BigInt(totalTransfers) : 0n;

    // Cost
    const totalGas = this.completedRebalances.reduce(
      (sum, r) => sum + r.cost.gas,
      0n,
    );
    const totalUsd = this.completedRebalances.reduce(
      (sum, r) => sum + r.cost.usd,
      0,
    );
    const perTransferUsd = totalTransfers > 0 ? totalUsd / totalTransfers : 0;

    return {
      initiated,
      completed,
      failed,
      volume: {
        total: totalVolume,
        perTransfer,
      },
      cost: {
        totalGas,
        totalUsd,
        perTransferUsd,
      },
    };
  }

  /**
   * Calculate final scores.
   */
  private calculateScores(
    transfers: TransferMetrics,
    rebalancing: RebalancingMetrics,
  ): SimulationScores {
    // Availability: % of transfers that completed successfully (not stuck)
    // AND didn't have to wait for collateral
    const successfulImmediate =
      transfers.completed - transfers.collateralWaitTime.affectedCount;
    const availability =
      transfers.total > 0 ? (successfulImmediate / transfers.total) * 100 : 100;

    // Latency score: inverse of p95 latency, normalized
    // Target: p95 latency should be close to warp latency (no waiting)
    // Score of 100 = p95 equals warp latency
    // Score of 0 = p95 is 10x warp latency or more
    const idealLatency = this.warpTransferLatencyMs;
    const actualP95 = transfers.latency.p95 || idealLatency;
    const latencyRatio = actualP95 / idealLatency;
    const latencyScore = Math.max(0, Math.min(100, (1 / latencyRatio) * 100));

    // Cost efficiency: transfers per dollar spent
    // Higher is better, normalized to 0-100
    // Target: $0.01 per transfer = score of 100
    // Score of 0 = $1 per transfer or more
    const costPerTransfer = rebalancing.cost.perTransferUsd;
    const costScore =
      costPerTransfer > 0
        ? Math.max(0, Math.min(100, (0.01 / costPerTransfer) * 100))
        : 100; // No cost = perfect score

    // Overall: weighted average
    // Availability is most important, then latency, then cost
    const overall = availability * 0.5 + latencyScore * 0.3 + costScore * 0.2;

    return {
      availability: Math.round(availability * 100) / 100,
      latency: Math.round(latencyScore * 100) / 100,
      costEfficiency: Math.round(costScore * 100) / 100,
      overall: Math.round(overall * 100) / 100,
    };
  }

  /**
   * Calculate latency statistics.
   */
  private calculateLatencyStats(latencies: number[]): LatencyStats {
    if (latencies.length === 0) {
      return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    }

    const sorted = [...latencies].sort((a, b) => a - b);

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: this.mean(latencies),
      p50: this.percentile(sorted, 50),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99),
    };
  }

  /**
   * Calculate mean of an array.
   */
  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Calculate percentile of a sorted array.
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }
}

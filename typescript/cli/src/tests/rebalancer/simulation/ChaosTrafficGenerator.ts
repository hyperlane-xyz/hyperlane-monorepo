/**
 * ChaosTrafficGenerator
 *
 * Generates random transfer traffic for simulation testing.
 */
import type { Address } from '@hyperlane-xyz/utils';

import { SeededRandom } from './BridgeSimulator.js';
import type { ChaosConfig, TrafficSource, Transfer } from './types.js';

/**
 * Generates random transfer traffic based on configuration.
 */
export class ChaosTrafficGenerator implements TrafficSource {
  private readonly config: ChaosConfig;
  private readonly random: SeededRandom;
  private readonly transfers: Transfer[];
  private readonly durationMs: number;

  constructor(config: ChaosConfig, durationMs: number) {
    this.config = config;
    this.durationMs = durationMs;
    this.random = new SeededRandom(config.seed ?? Date.now());
    this.transfers = this.generateTransfers();
  }

  /**
   * Pre-generate all transfers for the simulation duration.
   */
  private generateTransfers(): Transfer[] {
    const transfers: Transfer[] = [];
    const { transfersPerMinute, burstProbability = 0 } = this.config;

    // Average interval between transfers
    const avgIntervalMs = 60_000 / transfersPerMinute;

    let currentTime = 0;
    let transferId = 0;

    while (currentTime < this.durationMs) {
      // Check for burst
      const isBurst = this.random.chance(burstProbability);
      const transfersToGenerate = isBurst ? 10 : 1;

      for (let i = 0; i < transfersToGenerate; i++) {
        const transfer = this.generateSingleTransfer(
          `transfer-${transferId++}`,
          currentTime,
        );
        transfers.push(transfer);
      }

      // Time to next transfer (exponential distribution for realistic spacing)
      const interval = this.random.exponential(avgIntervalMs);
      currentTime += Math.max(100, interval); // minimum 100ms between transfers
    }

    return transfers;
  }

  /**
   * Generate a single transfer.
   */
  private generateSingleTransfer(id: string, timestamp: number): Transfer {
    const { origin, destination } = this.selectOriginDestination();
    const amount = this.generateAmount();

    return {
      id,
      timestamp,
      origin,
      destination,
      amount,
      sender: this.generateAddress(),
      recipient: this.generateAddress(),
    };
  }

  /**
   * Select origin and destination chains.
   */
  private selectOriginDestination(): { origin: string; destination: string } {
    const { chains, directionWeights } = this.config;

    if (directionWeights) {
      // Use weighted selection
      const origins = Object.keys(directionWeights);
      const origin = origins[Math.floor(this.random.next() * origins.length)];

      const destWeights = directionWeights[origin];
      const destination = this.weightedSelect(destWeights);

      return { origin, destination };
    }

    // Random selection (any chain to any other chain)
    let origin: string;
    let destination: string;

    do {
      origin = chains[Math.floor(this.random.next() * chains.length)];
      destination = chains[Math.floor(this.random.next() * chains.length)];
    } while (origin === destination);

    return { origin, destination };
  }

  /**
   * Select from weighted options.
   */
  private weightedSelect(weights: Record<string, number>): string {
    const entries = Object.entries(weights);
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let r = this.random.next() * total;

    for (const [key, weight] of entries) {
      r -= weight;
      if (r <= 0) return key;
    }

    return entries[entries.length - 1][0];
  }

  /**
   * Generate transfer amount based on distribution.
   */
  private generateAmount(): bigint {
    const { min, max, distribution } = this.config.amountDistribution;

    switch (distribution) {
      case 'uniform':
        return this.random.bigintRange(min, max);

      case 'pareto': {
        // Heavy-tailed: many small, few large
        // Use pareto with min as lower bound
        const minNum = Number(min);
        const maxNum = Number(max);
        const paretoValue = this.random.pareto(minNum, 1.5);
        const clampedValue = Math.min(paretoValue, maxNum);
        return BigInt(Math.floor(clampedValue));
      }

      case 'bimodal': {
        // Mix of retail (small) and whale (large) transfers
        const isWhale = this.random.chance(0.1); // 10% whales
        const minNum = Number(min);
        const maxNum = Number(max);

        if (isWhale) {
          // Whale: upper 30% of range
          const whaleMin = minNum + (maxNum - minNum) * 0.7;
          return BigInt(Math.floor(this.random.range(whaleMin, maxNum)));
        } else {
          // Retail: lower 50% of range
          const retailMax = minNum + (maxNum - minNum) * 0.5;
          return BigInt(Math.floor(this.random.range(minNum, retailMax)));
        }
      }

      default:
        return this.random.bigintRange(min, max);
    }
  }

  /**
   * Generate a random address.
   */
  private generateAddress(): Address {
    const hex = Array.from({ length: 40 }, () =>
      Math.floor(this.random.next() * 16).toString(16),
    ).join('');
    return `0x${hex}` as Address;
  }

  // ============================================================================
  // TrafficSource Interface
  // ============================================================================

  getTransfers(startTime: number, endTime: number): Transfer[] {
    return this.transfers.filter(
      (t) => t.timestamp >= startTime && t.timestamp < endTime,
    );
  }

  getTotalTransferCount(): number {
    return this.transfers.length;
  }

  getTimeRange(): { start: number; end: number } {
    return { start: 0, end: this.durationMs };
  }

  /**
   * Get all transfers (for debugging/inspection).
   */
  getAllTransfers(): Transfer[] {
    return [...this.transfers];
  }
}

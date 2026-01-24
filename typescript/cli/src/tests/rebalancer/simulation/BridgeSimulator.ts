/**
 * BridgeSimulator
 *
 * Simulates bridge behavior including latency and cost calculations.
 */
import type { BridgeConfig, LatencyDistribution } from './types.js';

/**
 * Simple seeded random number generator for reproducibility.
 */
export class SeededRandom {
  private seed: number;

  constructor(seed: number = Date.now()) {
    this.seed = seed;
  }

  /**
   * Returns a random number between 0 and 1.
   */
  next(): number {
    // LCG parameters (same as glibc)
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  /**
   * Returns a random number in [min, max].
   */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * Returns a random bigint in [min, max].
   */
  bigintRange(min: bigint, max: bigint): bigint {
    const range = max - min;
    const randomFraction = this.next();
    return min + BigInt(Math.floor(Number(range) * randomFraction));
  }

  /**
   * Returns true with the given probability.
   */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /**
   * Box-Muller transform for normal distribution.
   * Returns a value with mean 0 and stddev 1.
   */
  normalStandard(): number {
    const u1 = this.next();
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Normal distribution with given mean and stddev.
   */
  normal(mean: number, stddev: number): number {
    return mean + this.normalStandard() * stddev;
  }

  /**
   * Exponential distribution with given mean.
   */
  exponential(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }

  /**
   * Pareto distribution for heavy-tailed amounts.
   * Most values are small, few are large.
   */
  pareto(min: number, alpha: number = 1.5): number {
    const u = this.next();
    return min / Math.pow(u, 1 / alpha);
  }
}

/**
 * Simulates bridge latency and cost.
 */
export class BridgeSimulator {
  private random: SeededRandom;

  constructor(seed?: number) {
    this.random = new SeededRandom(seed);
  }

  /**
   * Calculate the latency for a bridge transfer.
   */
  getLatency(config: BridgeConfig): number {
    const { minLatencyMs, maxLatencyMs, latencyDistribution } = config;

    switch (latencyDistribution) {
      case 'uniform':
        return this.random.range(minLatencyMs, maxLatencyMs);

      case 'normal': {
        // Use min/max as ~3 sigma bounds
        const mean = (minLatencyMs + maxLatencyMs) / 2;
        const stddev = (maxLatencyMs - minLatencyMs) / 6;
        const latency = this.random.normal(mean, stddev);
        // Clamp to bounds
        return Math.max(minLatencyMs, Math.min(maxLatencyMs, latency));
      }

      case 'exponential': {
        // Mean is at the lower end, with tail extending to max
        const mean = minLatencyMs + (maxLatencyMs - minLatencyMs) * 0.3;
        const latency =
          minLatencyMs + this.random.exponential(mean - minLatencyMs);
        return Math.min(maxLatencyMs, latency);
      }

      default:
        return this.random.range(minLatencyMs, maxLatencyMs);
    }
  }

  /**
   * Calculate the cost for a bridge transfer.
   *
   * @param config Bridge configuration
   * @param amount Amount being transferred (in wei, 18 decimals)
   * @param gasPrice Gas price in wei
   * @param ethPriceUsd ETH price in USD
   * @param tokenPriceUsd Token price in USD (default 1 for stablecoins)
   */
  getCost(
    config: BridgeConfig,
    amount: bigint,
    gasPrice: bigint,
    ethPriceUsd: number,
    tokenPriceUsd: number = 1, // Default to $1 (stablecoin)
  ): { gas: bigint; usd: number } {
    const { fixedCostUsd, variableCostBps, gasEstimate } = config;

    // Gas cost in USD
    const gasCostWei = gasEstimate * gasPrice;
    const gasCostEth = Number(gasCostWei) / 1e18;
    const gasCostUsd = gasCostEth * ethPriceUsd;

    // Variable cost (basis points of transfer amount in USD)
    // Amount is in 18 decimals, convert to USD
    const amountInTokens = Number(amount) / 1e18;
    const amountUsd = amountInTokens * tokenPriceUsd;
    const variableCostUsd = (amountUsd * variableCostBps) / 10000;

    const totalUsd = fixedCostUsd + gasCostUsd + variableCostUsd;

    return {
      gas: gasEstimate,
      usd: totalUsd,
    };
  }

  /**
   * Check if the bridge transfer fails.
   */
  shouldFail(config: BridgeConfig): boolean {
    return this.random.chance(config.failureRate);
  }

  /**
   * Get the random instance for other uses.
   */
  getRandom(): SeededRandom {
    return this.random;
  }
}

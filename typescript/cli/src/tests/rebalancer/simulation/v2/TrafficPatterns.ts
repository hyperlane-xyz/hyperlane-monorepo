/**
 * Traffic Pattern Generators
 *
 * Generates realistic traffic patterns for simulation testing.
 */
import type { ScheduledTransfer, TrafficPattern, TrafficPatternConfig } from './types.js';

/**
 * Simple seeded random number generator for reproducibility.
 */
class SeededRandom {
  private seed: number;

  constructor(seed: number = Date.now()) {
    this.seed = seed;
  }

  /** Returns a random number between 0 and 1 */
  next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  /** Returns a random integer between min and max (inclusive) */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Returns a random element from an array */
  pick<T>(array: T[]): T {
    return array[this.nextInt(0, array.length - 1)];
  }

  /** Returns a random bigint between min and max */
  nextBigInt(min: bigint, max: bigint): bigint {
    const range = max - min;
    const randomFactor = BigInt(Math.floor(this.next() * Number(range)));
    return min + randomFactor;
  }
}

/**
 * Helper to pick a random destination different from origin.
 */
function pickDestination(
  rng: SeededRandom,
  origin: string,
  chains: string[],
): string {
  const available = chains.filter(c => c !== origin);
  if (available.length === 0) {
    throw new Error(`No valid destination for origin ${origin}`);
  }
  return rng.pick(available);
}

/**
 * Steady traffic pattern - uniform distribution over time.
 */
export const steadyTrafficPattern: TrafficPattern = {
  name: 'steady',
  generate(config: TrafficPatternConfig): ScheduledTransfer[] {
    const rng = new SeededRandom(config.seed);
    const transfers: ScheduledTransfer[] = [];

    // Generate ~1 transfer per minute
    const transfersPerMinute = 1;
    const totalMinutes = config.durationMs / (60 * 1000);
    const totalTransfers = Math.floor(totalMinutes * transfersPerMinute);

    for (let i = 0; i < totalTransfers; i++) {
      const time = rng.nextInt(0, config.durationMs - 1);
      
      // 70% chance of collateral -> synthetic, 30% synthetic -> collateral
      const toSynthetic = rng.next() < 0.7;
      
      let origin: string;
      let destination: string;
      
      if (toSynthetic && config.syntheticChains.length > 0) {
        origin = rng.pick(config.collateralChains);
        destination = rng.pick(config.syntheticChains);
      } else if (config.syntheticChains.length > 0) {
        // synthetic -> collateral (redemption)
        origin = rng.pick(config.syntheticChains);
        destination = rng.pick(config.collateralChains);
      } else {
        // No synthetic chains - pick different collateral chains
        origin = rng.pick(config.collateralChains);
        destination = pickDestination(rng, origin, config.collateralChains);
      }

      // Random amount between 0.5x and 2x base amount
      const amount = rng.nextBigInt(config.baseAmount / 2n, config.baseAmount * 2n);

      transfers.push({ time, origin, destination, amount });
    }

    return transfers.sort((a, b) => a.time - b.time);
  },
};

/**
 * Burst traffic pattern - periods of high activity followed by quiet periods.
 */
export const burstTrafficPattern: TrafficPattern = {
  name: 'burst',
  generate(config: TrafficPatternConfig): ScheduledTransfer[] {
    const rng = new SeededRandom(config.seed);
    const transfers: ScheduledTransfer[] = [];

    // Create 3-5 burst periods
    const numBursts = rng.nextInt(3, 5);
    const burstDuration = 2 * 60 * 1000; // 2 minutes per burst
    const transfersPerBurst = rng.nextInt(5, 10);

    for (let burst = 0; burst < numBursts; burst++) {
      // Random burst start time
      const burstStart = rng.nextInt(0, config.durationMs - burstDuration);

      for (let i = 0; i < transfersPerBurst; i++) {
        const time = burstStart + rng.nextInt(0, burstDuration);
        
        // During bursts, traffic is heavily one-directional
        const toSynthetic = rng.next() < 0.9; // 90% to synthetic during bursts
        
        let origin: string;
        let destination: string;
        
        if (toSynthetic && config.syntheticChains.length > 0) {
          origin = rng.pick(config.collateralChains);
          destination = rng.pick(config.syntheticChains);
        } else if (config.syntheticChains.length > 0) {
          origin = rng.pick(config.syntheticChains);
          destination = rng.pick(config.collateralChains);
        } else {
          origin = rng.pick(config.collateralChains);
          destination = pickDestination(rng, origin, config.collateralChains);
        }

        // Larger amounts during bursts
        const amount = rng.nextBigInt(config.baseAmount, config.baseAmount * 3n);

        transfers.push({ time, origin, destination, amount });
      }
    }

    return transfers.sort((a, b) => a.time - b.time);
  },
};

/**
 * Imbalanced traffic pattern - heavily favors one direction to create imbalance.
 * This is useful for testing rebalancer effectiveness.
 */
export const imbalancedTrafficPattern: TrafficPattern = {
  name: 'imbalanced',
  generate(config: TrafficPatternConfig): ScheduledTransfer[] {
    const rng = new SeededRandom(config.seed);
    const transfers: ScheduledTransfer[] = [];

    // Generate steady traffic but heavily favor one collateral chain
    const favoredChain = config.collateralChains[0];
    const otherCollateralChains = config.collateralChains.filter(c => c !== favoredChain);
    const totalMinutes = config.durationMs / (60 * 1000);
    const transfersPerMinute = 1.5;
    const totalTransfers = Math.floor(totalMinutes * transfersPerMinute);

    for (let i = 0; i < totalTransfers; i++) {
      const time = rng.nextInt(0, config.durationMs - 1);
      
      // 80% from favored chain, 20% from others
      const fromFavored = rng.next() < 0.8;
      
      let origin: string;
      let destination: string;
      
      if (fromFavored) {
        origin = favoredChain;
        if (config.syntheticChains.length > 0) {
          destination = rng.pick(config.syntheticChains);
        } else if (otherCollateralChains.length > 0) {
          destination = rng.pick(otherCollateralChains);
        } else {
          continue; // Skip if no valid destination
        }
      } else {
        if (otherCollateralChains.length > 0) {
          origin = rng.pick(otherCollateralChains);
        } else {
          continue; // Skip if no other chains
        }
        destination = config.syntheticChains.length > 0
          ? rng.pick(config.syntheticChains)
          : favoredChain;
      }

      const amount = rng.nextBigInt(config.baseAmount / 2n, config.baseAmount * 2n);

      transfers.push({ time, origin, destination, amount });
    }

    return transfers.sort((a, b) => a.time - b.time);
  },
};

/**
 * Heavy one-way traffic - all traffic goes from one chain to create maximum imbalance.
 * This will definitely trigger collateral deficits on the destination.
 */
export const heavyOneWayPattern: TrafficPattern = {
  name: 'heavy-one-way',
  generate(config: TrafficPatternConfig): ScheduledTransfer[] {
    const rng = new SeededRandom(config.seed);
    const transfers: ScheduledTransfer[] = [];

    const sourceChain = config.collateralChains[0];
    const destChain = config.syntheticChains.length > 0 
      ? config.syntheticChains[0] 
      : config.collateralChains[1];

    // Generate heavy traffic - 2 transfers per minute
    const totalMinutes = config.durationMs / (60 * 1000);
    const transfersPerMinute = 2;
    const totalTransfers = Math.floor(totalMinutes * transfersPerMinute);

    for (let i = 0; i < totalTransfers; i++) {
      const time = rng.nextInt(0, config.durationMs - 1);
      
      // Large transfers to quickly drain/build collateral
      const amount = rng.nextBigInt(config.baseAmount, config.baseAmount * 5n);

      transfers.push({
        time,
        origin: sourceChain,
        destination: destChain,
        amount,
      });
    }

    return transfers.sort((a, b) => a.time - b.time);
  },
};

/**
 * Bidirectional imbalanced - traffic goes both ways but more in one direction.
 * More realistic for testing rebalancer over time.
 */
export const bidirectionalImbalancedPattern: TrafficPattern = {
  name: 'bidirectional-imbalanced',
  generate(config: TrafficPatternConfig): ScheduledTransfer[] {
    const rng = new SeededRandom(config.seed);
    const transfers: ScheduledTransfer[] = [];

    const totalMinutes = config.durationMs / (60 * 1000);
    const transfersPerMinute = 1.5;
    const totalTransfers = Math.floor(totalMinutes * transfersPerMinute);

    // Phase 1: First half - heavy traffic from chain1 to synthetic
    // Phase 2: Second half - some traffic back but not enough to balance

    const midPoint = config.durationMs / 2;

    for (let i = 0; i < totalTransfers; i++) {
      const time = rng.nextInt(0, config.durationMs - 1);
      
      let origin: string;
      let destination: string;
      let amount: bigint;

      if (time < midPoint) {
        // Phase 1: 90% from chain1 to synthetic
        if (rng.next() < 0.9) {
          origin = config.collateralChains[0];
          destination = config.syntheticChains[0] || config.collateralChains[1];
          amount = rng.nextBigInt(config.baseAmount, config.baseAmount * 3n);
        } else {
          origin = config.collateralChains[1] || config.collateralChains[0];
          destination = config.syntheticChains[0] || config.collateralChains[0];
          amount = rng.nextBigInt(config.baseAmount / 2n, config.baseAmount);
        }
      } else {
        // Phase 2: 60% still from chain1, 40% returning
        if (rng.next() < 0.6) {
          origin = config.collateralChains[0];
          destination = config.syntheticChains[0] || config.collateralChains[1];
          amount = rng.nextBigInt(config.baseAmount / 2n, config.baseAmount * 2n);
        } else {
          // Traffic returning (synthetic -> collateral or chain2 -> chain1)
          origin = config.syntheticChains[0] || config.collateralChains[1];
          destination = rng.pick(config.collateralChains);
          amount = rng.nextBigInt(config.baseAmount / 2n, config.baseAmount);
        }
      }

      transfers.push({ time, origin, destination, amount });
    }

    return transfers.sort((a, b) => a.time - b.time);
  },
};

/**
 * Get all available traffic patterns.
 */
export const trafficPatterns: Record<string, TrafficPattern> = {
  steady: steadyTrafficPattern,
  burst: burstTrafficPattern,
  imbalanced: imbalancedTrafficPattern,
  'heavy-one-way': heavyOneWayPattern,
  'bidirectional-imbalanced': bidirectionalImbalancedPattern,
};

/**
 * Generate a traffic schedule using a named pattern.
 */
export function generateTraffic(
  patternName: string,
  config: TrafficPatternConfig,
): ScheduledTransfer[] {
  const pattern = trafficPatterns[patternName];
  if (!pattern) {
    throw new Error(`Unknown traffic pattern: ${patternName}. Available: ${Object.keys(trafficPatterns).join(', ')}`);
  }
  return pattern.generate(config);
}

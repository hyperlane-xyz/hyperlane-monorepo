import { randomAddress } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type {
  RandomTrafficOptions,
  SerializedScenario,
  SerializedTransferEvent,
  SurgeScenarioOptions,
  TransferEvent,
  TransferScenario,
  UnidirectionalFlowOptions,
} from './types.js';

/**
 * Generates random bigint in range [min, max] (inclusive)
 * Uses chunked random generation to avoid precision loss for large ranges
 */
function randomBigIntInRange(min: bigint, max: bigint): bigint {
  const range = max - min + BigInt(1); // +1 to make max inclusive

  // For small ranges that fit in Number.MAX_SAFE_INTEGER, use simple approach
  if (range <= BigInt(Number.MAX_SAFE_INTEGER)) {
    const randomFactor = BigInt(Math.floor(Math.random() * Number(range)));
    return min + randomFactor;
  }

  // For large ranges, generate random bytes and mod by range
  // This avoids precision loss by working with bigints throughout
  const rangeHex = range.toString(16);
  const bytesNeeded = Math.ceil(rangeHex.length / 2) + 1; // +1 for safety margin

  let randomBigInt = BigInt(0);
  for (let i = 0; i < bytesNeeded; i++) {
    randomBigInt =
      (randomBigInt << BigInt(8)) | BigInt(Math.floor(Math.random() * 256));
  }

  return min + (randomBigInt % range);
}

/**
 * Generates a unique transfer ID
 */
function generateTransferId(index: number, prefix: string = 'tx'): string {
  return `${prefix}-${index.toString().padStart(6, '0')}`;
}

/**
 * Generates a Poisson-distributed interval
 */
function poissonInterval(meanInterval: number): number {
  // Using inverse transform sampling for exponential distribution
  const u = Math.random();
  return -Math.log(1 - u) * meanInterval;
}

/**
 * ScenarioGenerator creates transfer scenarios for simulation testing.
 */
export class ScenarioGenerator {
  /**
   * Generates a unidirectional flow scenario where all transfers
   * go from one chain to another.
   */
  static unidirectionalFlow(
    options: UnidirectionalFlowOptions,
  ): TransferScenario {
    const {
      origin,
      destination,
      transferCount,
      duration,
      amount,
      user = randomAddress(),
    } = options;

    const interval = duration / transferCount;
    const transfers: TransferEvent[] = [];

    for (let i = 0; i < transferCount; i++) {
      const transferAmount = Array.isArray(amount)
        ? randomBigIntInRange(amount[0], amount[1])
        : amount;

      transfers.push({
        id: generateTransferId(i, 'uni'),
        timestamp: Math.floor(i * interval),
        origin,
        destination,
        amount: transferAmount,
        user: user as Address,
      });
    }

    return {
      name: `unidirectional-${origin}-to-${destination}-${transferCount}tx`,
      duration,
      transfers,
      chains: [origin, destination],
    };
  }

  /**
   * Generates random traffic across multiple chains with configurable distribution.
   */
  static randomTraffic(options: RandomTrafficOptions): TransferScenario {
    const {
      chains,
      transferCount,
      duration,
      amountRange,
      users = [randomAddress() as Address],
      distribution = 'uniform',
      poissonMeanInterval,
    } = options;

    if (chains.length < 2) {
      throw new Error('Random traffic requires at least 2 chains');
    }

    const transfers: TransferEvent[] = [];
    let currentTime = 0;

    for (let i = 0; i < transferCount; i++) {
      // Pick random origin and destination (must be different)
      const originIndex = Math.floor(Math.random() * chains.length);
      let destIndex = Math.floor(Math.random() * chains.length);
      while (destIndex === originIndex) {
        destIndex = Math.floor(Math.random() * chains.length);
      }

      // Calculate timestamp based on distribution
      let timestamp: number;
      if (distribution === 'poisson' && poissonMeanInterval) {
        currentTime += poissonInterval(poissonMeanInterval);
        timestamp = Math.min(Math.floor(currentTime), duration);
      } else {
        timestamp = Math.floor(Math.random() * duration);
      }

      transfers.push({
        id: generateTransferId(i, 'rnd'),
        timestamp,
        origin: chains[originIndex],
        destination: chains[destIndex],
        amount: randomBigIntInRange(amountRange[0], amountRange[1]),
        user: users[Math.floor(Math.random() * users.length)],
      });
    }

    // Sort by timestamp
    transfers.sort((a, b) => a.timestamp - b.timestamp);

    return {
      name: `random-${chains.length}chains-${transferCount}tx`,
      duration,
      transfers,
      chains,
    };
  }

  /**
   * Generates a surge scenario with baseline traffic and a surge period.
   */
  static surgeScenario(options: SurgeScenarioOptions): TransferScenario {
    const {
      chains,
      baselineRate,
      surgeMultiplier,
      surgeStart,
      surgeDuration,
      totalDuration,
      amountRange,
    } = options;

    const transfers: TransferEvent[] = [];
    let txIndex = 0;

    // Generate baseline traffic
    const baselineInterval = 1000 / baselineRate; // ms between transfers
    for (let t = 0; t < totalDuration; t += baselineInterval) {
      // Skip surge period for baseline
      if (t >= surgeStart && t < surgeStart + surgeDuration) {
        continue;
      }

      const originIndex = Math.floor(Math.random() * chains.length);
      let destIndex = Math.floor(Math.random() * chains.length);
      while (destIndex === originIndex) {
        destIndex = Math.floor(Math.random() * chains.length);
      }

      transfers.push({
        id: generateTransferId(txIndex++, 'base'),
        timestamp: Math.floor(t),
        origin: chains[originIndex],
        destination: chains[destIndex],
        amount: randomBigIntInRange(amountRange[0], amountRange[1]),
        user: randomAddress() as Address,
      });
    }

    // Generate surge traffic
    const surgeRate = baselineRate * surgeMultiplier;
    const surgeInterval = 1000 / surgeRate;
    for (
      let t = surgeStart;
      t < surgeStart + surgeDuration;
      t += surgeInterval
    ) {
      const originIndex = Math.floor(Math.random() * chains.length);
      let destIndex = Math.floor(Math.random() * chains.length);
      while (destIndex === originIndex) {
        destIndex = Math.floor(Math.random() * chains.length);
      }

      transfers.push({
        id: generateTransferId(txIndex++, 'surge'),
        timestamp: Math.floor(t),
        origin: chains[originIndex],
        destination: chains[destIndex],
        amount: randomBigIntInRange(amountRange[0], amountRange[1]),
        user: randomAddress() as Address,
      });
    }

    // Sort by timestamp
    transfers.sort((a, b) => a.timestamp - b.timestamp);

    return {
      name: `surge-${chains.length}chains-${surgeMultiplier}x`,
      duration: totalDuration,
      transfers,
      chains,
    };
  }

  /**
   * Generates truly balanced traffic where each chain has equal in/out flows.
   * For every transfer A→B, generates a matching B→A transfer.
   */
  static balancedTraffic(options: {
    chains: string[];
    pairCount: number; // Number of balanced pairs
    duration: number;
    amountRange: [bigint, bigint];
  }): TransferScenario {
    const { chains, pairCount, duration, amountRange } = options;

    if (chains.length < 2) {
      throw new Error('Balanced traffic requires at least 2 chains');
    }

    const transfers: TransferEvent[] = [];
    let txIndex = 0;

    // Generate chain pairs
    const chainPairs: Array<[string, string]> = [];
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        chainPairs.push([chains[i], chains[j]]);
      }
    }

    // For each pair count, create a balanced pair of transfers
    for (let i = 0; i < pairCount; i++) {
      const pair = chainPairs[i % chainPairs.length];
      const amount = randomBigIntInRange(amountRange[0], amountRange[1]);
      const baseTime = Math.floor((i / pairCount) * duration * 0.9); // Leave 10% buffer

      // A → B
      transfers.push({
        id: generateTransferId(txIndex++, 'bal'),
        timestamp: baseTime,
        origin: pair[0],
        destination: pair[1],
        amount,
        user: randomAddress() as Address,
      });

      // B → A (same amount, slightly later)
      transfers.push({
        id: generateTransferId(txIndex++, 'bal'),
        timestamp: baseTime + Math.floor(Math.random() * 500), // 0-500ms later
        origin: pair[1],
        destination: pair[0],
        amount,
        user: randomAddress() as Address,
      });
    }

    // Sort by timestamp
    transfers.sort((a, b) => a.timestamp - b.timestamp);

    return {
      name: `balanced-${chains.length}chains-${pairCount * 2}tx`,
      duration,
      transfers,
      chains,
    };
  }

  /**
   * Creates an imbalance scenario where one chain receives more than others.
   * Useful for testing rebalancer response to imbalanced liquidity.
   */
  static imbalanceScenario(
    chains: string[],
    heavyChain: string,
    transferCount: number,
    duration: number,
    amountRange: [bigint, bigint],
    imbalanceRatio: number = 0.8, // 80% of transfers go to heavy chain
  ): TransferScenario {
    const transfers: TransferEvent[] = [];
    const otherChains = chains.filter((c) => c !== heavyChain);

    for (let i = 0; i < transferCount; i++) {
      const timestamp = Math.floor((i / transferCount) * duration);
      const goToHeavy = Math.random() < imbalanceRatio;

      let origin: string;
      let destination: string;

      if (goToHeavy) {
        origin = otherChains[Math.floor(Math.random() * otherChains.length)];
        destination = heavyChain;
      } else {
        origin = heavyChain;
        destination =
          otherChains[Math.floor(Math.random() * otherChains.length)];
      }

      transfers.push({
        id: generateTransferId(i, 'imb'),
        timestamp,
        origin,
        destination,
        amount: randomBigIntInRange(amountRange[0], amountRange[1]),
        user: randomAddress() as Address,
      });
    }

    return {
      name: `imbalance-${heavyChain}-${imbalanceRatio * 100}pct`,
      duration,
      transfers,
      chains,
    };
  }

  /**
   * Serializes a scenario to JSON-compatible format
   */
  static serialize(scenario: TransferScenario): SerializedScenario {
    return {
      name: scenario.name,
      duration: scenario.duration,
      chains: scenario.chains,
      transfers: scenario.transfers.map((t) => ({
        id: t.id,
        timestamp: t.timestamp,
        origin: t.origin,
        destination: t.destination,
        amount: t.amount.toString(),
        user: t.user,
      })),
    };
  }

  /**
   * Deserializes a scenario from JSON format
   */
  static deserialize(data: SerializedScenario): TransferScenario {
    return {
      name: data.name,
      duration: data.duration,
      chains: data.chains,
      transfers: data.transfers.map((t: SerializedTransferEvent) => ({
        id: t.id,
        timestamp: t.timestamp,
        origin: t.origin,
        destination: t.destination,
        amount: BigInt(t.amount),
        user: t.user as Address,
      })),
    };
  }

  /**
   * Validates a scenario for consistency
   */
  static validate(scenario: TransferScenario): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check transfers are sorted
    for (let i = 1; i < scenario.transfers.length; i++) {
      if (
        scenario.transfers[i].timestamp < scenario.transfers[i - 1].timestamp
      ) {
        errors.push(`Transfers not sorted at index ${i}`);
      }
    }

    // Check all chains in transfers are in chains list
    const chainSet = new Set(scenario.chains);
    for (const transfer of scenario.transfers) {
      if (!chainSet.has(transfer.origin)) {
        errors.push(`Unknown origin chain: ${transfer.origin}`);
      }
      if (!chainSet.has(transfer.destination)) {
        errors.push(`Unknown destination chain: ${transfer.destination}`);
      }
      if (transfer.origin === transfer.destination) {
        errors.push(`Same origin and destination: ${transfer.origin}`);
      }
    }

    // Check timestamps within duration
    for (const transfer of scenario.transfers) {
      if (transfer.timestamp > scenario.duration) {
        errors.push(
          `Transfer timestamp ${transfer.timestamp} exceeds duration ${scenario.duration}`,
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

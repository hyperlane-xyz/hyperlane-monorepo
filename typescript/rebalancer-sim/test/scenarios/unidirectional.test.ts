/**
 * SCENARIO GENERATOR TEST SUITE
 * =============================
 *
 * These tests verify the ScenarioGenerator creates valid transfer scenarios
 * for simulation testing.
 *
 * SCENARIO TYPES:
 *
 * 1. unidirectionalFlow:
 *    All transfers go from one chain to another.
 *    Use case: Testing sustained liquidity drain on destination chain.
 *    Example: All users sending from Ethereum to Arbitrum.
 *
 * 2. randomTraffic:
 *    Transfers randomly distributed across all chain pairs.
 *    Use case: Testing balanced/organic traffic patterns.
 *    Distributions: uniform (equal probability) or poisson (realistic bursts).
 *
 * 3. imbalanceScenario:
 *    Weighted traffic favoring one chain as destination.
 *    Use case: Testing rebalancer response to skewed traffic.
 *    Example: 90% of transfers going TO one popular chain.
 *
 * 4. surgeScenario:
 *    Baseline traffic with sudden spike in volume.
 *    Use case: Testing rebalancer under traffic bursts.
 *    Example: NFT mint causing sudden transfer surge.
 *
 * SCENARIO STRUCTURE:
 * ```typescript
 * interface TransferScenario {
 *   name: string;           // Descriptive name
 *   duration: number;       // Total scenario duration (ms)
 *   chains: string[];       // Participating chains
 *   transfers: Transfer[];  // Ordered list of transfers
 * }
 *
 * interface Transfer {
 *   id: string;             // Unique identifier
 *   timestamp: number;      // When to execute (ms from start)
 *   origin: string;         // Source chain
 *   destination: string;    // Target chain
 *   amount: bigint;         // Transfer amount in wei
 *   user: string;           // User address (for tracking)
 * }
 * ```
 */
import { expect } from 'chai';

import { toWei } from '@hyperlane-xyz/utils';

import { ScenarioGenerator } from '../../src/scenario/ScenarioGenerator.js';

describe('ScenarioGenerator', () => {
  /**
   * UNIDIRECTIONAL FLOW TESTS
   * -------------------------
   * Tests for scenarios where all transfers go in one direction.
   * This is the simplest scenario type and creates maximum imbalance.
   */
  describe('unidirectionalFlow', () => {
    it('should generate correct number of transfers', () => {
      const scenario = ScenarioGenerator.unidirectionalFlow({
        origin: 'chain1',
        destination: 'chain2',
        transferCount: 100,
        duration: 60000,
        amount: BigInt(toWei(1)),
      });

      expect(scenario.transfers.length).to.equal(100);
      expect(scenario.chains).to.deep.equal(['chain1', 'chain2']);
    });

    it('should have transfers in chronological order', () => {
      const scenario = ScenarioGenerator.unidirectionalFlow({
        origin: 'chain1',
        destination: 'chain2',
        transferCount: 50,
        duration: 30000,
        amount: BigInt(toWei(1)),
      });

      for (let i = 1; i < scenario.transfers.length; i++) {
        expect(scenario.transfers[i].timestamp).to.be.at.least(
          scenario.transfers[i - 1].timestamp,
        );
      }
    });

    it('should use amount range correctly', () => {
      const minAmount = BigInt(toWei(1));
      const maxAmount = BigInt(toWei(10));

      const scenario = ScenarioGenerator.unidirectionalFlow({
        origin: 'chain1',
        destination: 'chain2',
        transferCount: 100,
        duration: 60000,
        amount: [minAmount, maxAmount],
      });

      for (const transfer of scenario.transfers) {
        expect(transfer.amount >= minAmount).to.be.true;
        expect(transfer.amount <= maxAmount).to.be.true;
      }
    });

    it('should set all transfers to same origin/destination', () => {
      const scenario = ScenarioGenerator.unidirectionalFlow({
        origin: 'chainA',
        destination: 'chainB',
        transferCount: 20,
        duration: 10000,
        amount: BigInt(toWei(1)),
      });

      for (const transfer of scenario.transfers) {
        expect(transfer.origin).to.equal('chainA');
        expect(transfer.destination).to.equal('chainB');
      }
    });
  });

  /**
   * RANDOM TRAFFIC TESTS
   * --------------------
   * Tests for scenarios with randomly distributed traffic.
   * Should naturally balance out over large sample sizes.
   * Tests both uniform and poisson distributions.
   */
  describe('randomTraffic', () => {
    it('should generate correct number of transfers', () => {
      const scenario = ScenarioGenerator.randomTraffic({
        chains: ['chain1', 'chain2', 'chain3'],
        transferCount: 100,
        duration: 60000,
        amountRange: [BigInt(toWei(1)), BigInt(toWei(10))],
      });

      expect(scenario.transfers.length).to.equal(100);
      expect(scenario.chains).to.deep.equal(['chain1', 'chain2', 'chain3']);
    });

    it('should use all chains', () => {
      const chains = ['chain1', 'chain2', 'chain3'];
      const scenario = ScenarioGenerator.randomTraffic({
        chains,
        transferCount: 1000,
        duration: 60000,
        amountRange: [BigInt(toWei(1)), BigInt(toWei(10))],
      });

      const usedOrigins = new Set(scenario.transfers.map((t) => t.origin));
      const usedDestinations = new Set(
        scenario.transfers.map((t) => t.destination),
      );

      // With 1000 transfers across 3 chains, all should be used
      for (const chain of chains) {
        expect(usedOrigins.has(chain)).to.be.true;
        expect(usedDestinations.has(chain)).to.be.true;
      }
    });

    it('should never have same origin and destination', () => {
      const scenario = ScenarioGenerator.randomTraffic({
        chains: ['chain1', 'chain2', 'chain3'],
        transferCount: 500,
        duration: 60000,
        amountRange: [BigInt(toWei(1)), BigInt(toWei(10))],
      });

      for (const transfer of scenario.transfers) {
        expect(transfer.origin).to.not.equal(transfer.destination);
      }
    });

    it('should throw for single chain', () => {
      expect(() => {
        ScenarioGenerator.randomTraffic({
          chains: ['chain1'],
          transferCount: 10,
          duration: 10000,
          amountRange: [BigInt(1), BigInt(10)],
        });
      }).to.throw('Random traffic requires at least 2 chains');
    });
  });

  /**
   * IMBALANCE SCENARIO TESTS
   * ------------------------
   * Tests for scenarios that deliberately create imbalanced traffic.
   * Used to verify rebalancer triggers at correct thresholds.
   * The 'heavyRatio' parameter controls what % of transfers go TO the heavy chain.
   */
  describe('imbalanceScenario', () => {
    it('should create imbalanced traffic', () => {
      const scenario = ScenarioGenerator.imbalanceScenario(
        ['chain1', 'chain2', 'chain3'],
        'chain1', // heavy chain
        1000,
        60000,
        [BigInt(toWei(1)), BigInt(toWei(5))],
        0.9, // 90% to heavy chain
      );

      const toHeavy = scenario.transfers.filter(
        (t) => t.destination === 'chain1',
      ).length;
      const ratio = toHeavy / scenario.transfers.length;

      // Should be close to 90% (allow some variance due to randomness)
      expect(ratio).to.be.greaterThan(0.85);
      expect(ratio).to.be.lessThan(0.95);
    });
  });

  /**
   * SERIALIZATION TESTS
   * -------------------
   * Tests for saving/loading scenarios to/from JSON files.
   * This enables:
   * - Sharing scenarios across test runs
   * - Storing historic scenarios fetched from explorers
   * - Reproducible testing with identical scenarios
   *
   * IMPORTANT: BigInt amounts are serialized as strings to preserve precision.
   */
  describe('serialization', () => {
    it('should serialize and deserialize correctly', () => {
      const original = ScenarioGenerator.unidirectionalFlow({
        origin: 'chain1',
        destination: 'chain2',
        transferCount: 10,
        duration: 10000,
        amount: BigInt(toWei(5)),
      });

      const serialized = ScenarioGenerator.serialize(original);
      const deserialized = ScenarioGenerator.deserialize(serialized);

      expect(deserialized.name).to.equal(original.name);
      expect(deserialized.duration).to.equal(original.duration);
      expect(deserialized.chains).to.deep.equal(original.chains);
      expect(deserialized.transfers.length).to.equal(original.transfers.length);

      for (let i = 0; i < original.transfers.length; i++) {
        expect(deserialized.transfers[i].id).to.equal(original.transfers[i].id);
        expect(deserialized.transfers[i].amount.toString()).to.equal(
          original.transfers[i].amount.toString(),
        );
      }
    });
  });

  /**
   * VALIDATION TESTS
   * ----------------
   * Tests for scenario validation logic.
   * Validation catches:
   * - Unknown chains in transfers
   * - Invalid amounts (zero, negative)
   * - Out-of-order timestamps
   * - Same origin/destination
   *
   * Run validation before simulation to catch scenario bugs early.
   */
  describe('validate', () => {
    it('should validate correct scenario', () => {
      const scenario = ScenarioGenerator.randomTraffic({
        chains: ['chain1', 'chain2'],
        transferCount: 10,
        duration: 10000,
        amountRange: [BigInt(1), BigInt(10)],
      });

      const result = ScenarioGenerator.validate(scenario);
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('should detect unknown chains', () => {
      const scenario = ScenarioGenerator.unidirectionalFlow({
        origin: 'chain1',
        destination: 'chain2',
        transferCount: 5,
        duration: 5000,
        amount: BigInt(1),
      });

      // Manually corrupt the chains list
      scenario.chains = ['chain1'];

      const result = ScenarioGenerator.validate(scenario);
      expect(result.valid).to.be.false;
      expect(result.errors.some((e) => e.includes('Unknown destination chain')))
        .to.be.true;
    });
  });
});

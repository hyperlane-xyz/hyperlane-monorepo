/**
 * Simulation E2E Tests
 *
 * Tests the IntegratedSimulation with the real RebalancerService.
 * Uses minimal delays (100ms) for fast test execution while still
 * running the actual rebalancer daemon.
 * 
 * Each test gets a fresh Anvil instance and contract deployment to ensure
 * complete isolation. Deployment takes ~1.5s, which is acceptable overhead.
 */
import { expect } from 'chai';
import { pino } from 'pino';

import { toWei } from '@hyperlane-xyz/utils';

import {
  type AnvilInstance,
  DOMAIN_1,
  DOMAIN_2,
  createRebalancerTestSetup,
  type RebalancerTestSetup,
  startAnvil,
} from '../../harness/index.js';
import {
  IntegratedSimulation,
  createWeightedStrategyConfig,
} from './IntegratedSimulation.js';
import { visualizeSimulation } from './SimulationVisualizer.js';
import type { SimulationRun, ScheduledTransfer } from './types.js';

// Logger for tests - use 'warn' to suppress verbose rebalancer logs
const logger = pino({ level: 'warn' });

// Use only 2 collateral domains for simpler rebalancing scenarios
const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];

// Smaller pool size (1000 tokens) so transfers have bigger impact
const INITIAL_COLLATERAL = toWei('1000'); // 1,000 tokens per domain

// Track port for each test to allow parallel execution
let nextPort = 8545;

/**
 * Create and initialize an IntegratedSimulation with minimal delays.
 */
async function createSimulation(setup: RebalancerTestSetup): Promise<IntegratedSimulation> {
  const strategyConfig = createWeightedStrategyConfig(setup, {
    [DOMAIN_1.name]: { weight: 50, tolerance: 5 },
    [DOMAIN_2.name]: { weight: 50, tolerance: 5 },
  });

  const simulation = new IntegratedSimulation({
    setup,
    warpRouteId: 'test-warp-route',
    messageDeliveryDelayMs: 100,
    deliveryCheckIntervalMs: 50,
    recordingIntervalMs: 200,
    rebalancerCheckFrequencyMs: 500,
    bridgeTransferDelayMs: 200,
    bridgeConfigs: {
      [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
        fixedFee: BigInt(toWei('0.1')),
        variableFeeBps: 10,
        transferTimeMs: 200,
      },
      [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
        fixedFee: BigInt(toWei('0.1')),
        variableFeeBps: 10,
        transferTimeMs: 200,
      },
    },
    strategyConfig,
    logger,
  });

  await simulation.initialize();
  return simulation;
}

/**
 * Start fresh Anvil and deploy contracts.
 */
async function setupFreshEnvironment(): Promise<{ anvil: AnvilInstance; setup: RebalancerTestSetup }> {
  const port = nextPort++;
  const anvil = await startAnvil(port, logger);
  
  const setup = await createRebalancerTestSetup({
    collateralDomains: COLLATERAL_DOMAINS,
    syntheticDomains: [],
    initialCollateral: BigInt(INITIAL_COLLATERAL),
    logger,
    rpcUrl: anvil.rpcUrl,
    simulatedBridge: { fixedFee: 0n, variableFeeBps: 10 },
  });

  return { anvil, setup };
}

describe('Simulation (with Real RebalancerService)', function () {
  this.timeout(60_000);

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;

  beforeEach(async function () {
    const env = await setupFreshEnvironment();
    anvil = env.anvil;
    setup = env.setup;
  });

  afterEach(async function () {
    if (anvil) {
      await anvil.stop();
    }
  });

  it('Heavy One-Way Traffic: should trigger multiple rebalances', async function () {
    const simulation = await createSimulation(setup);

    // 20 transfers of 30 tokens each = 600 tokens one way (60% of pool!)
    const transfers: ScheduledTransfer[] = [];
    for (let i = 0; i < 20; i++) {
      transfers.push({
        time: i * 150,
        origin: DOMAIN_1.name,
        destination: DOMAIN_2.name,
        amount: BigInt(toWei('30')),
      });
    }

    const schedule: SimulationRun = {
      name: 'heavy-one-way',
      durationMs: 10_000,
      transfers,
    };

    console.log(`\nRunning: ${transfers.length} transfers, all domain1 → domain2 (600 tokens total)\n`);

    const results = await simulation.run(schedule);
    console.log(visualizeSimulation(results));

    expect(results.transfers.completed).to.equal(20);
    expect(results.rebalancing.count).to.be.greaterThanOrEqual(3);
  });

  it('Bidirectional 80/20 Traffic: should rebalance imbalanced flow', async function () {
    const simulation = await createSimulation(setup);

    // 20 transfers with 80% going one direction
    const transfers: ScheduledTransfer[] = [];
    for (let i = 0; i < 20; i++) {
      const goingToDomain2 = i % 5 !== 0; // 80% go to domain2
      transfers.push({
        time: i * 150,
        origin: goingToDomain2 ? DOMAIN_1.name : DOMAIN_2.name,
        destination: goingToDomain2 ? DOMAIN_2.name : DOMAIN_1.name,
        amount: BigInt(toWei('25')),
      });
    }

    const schedule: SimulationRun = {
      name: 'bidirectional-80-20',
      durationMs: 10_000,
      transfers,
    };

    const toDomain2 = transfers.filter(t => t.destination === DOMAIN_2.name).length;
    const toDomain1 = transfers.filter(t => t.destination === DOMAIN_1.name).length;
    console.log(`\nRunning: ${toDomain2} to domain2, ${toDomain1} to domain1 (net ${(toDomain2 - toDomain1) * 25} tokens)\n`);

    const results = await simulation.run(schedule);
    console.log(visualizeSimulation(results));

    expect(results.transfers.completed).to.equal(20);
    expect(results.rebalancing.count).to.be.greaterThanOrEqual(2);
  });
});

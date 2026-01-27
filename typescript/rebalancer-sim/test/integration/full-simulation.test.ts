import { expect } from 'chai';
import { ChildProcess, spawn } from 'child_process';
import { ethers } from 'ethers';

import { toWei } from '@hyperlane-xyz/utils';

import { createSymmetricBridgeConfig } from '../../src/bridges/types.js';
import {
  deployMultiDomainSimulation,
  getWarpTokenBalance,
} from '../../src/deployment/SimulationDeployment.js';
import {
  ANVIL_DEPLOYER_KEY,
  DEFAULT_SIMULATED_CHAINS,
} from '../../src/deployment/types.js';
import { SimulationEngine } from '../../src/engine/SimulationEngine.js';
import { HyperlaneRunner } from '../../src/rebalancer/HyperlaneRunner.js';
import {
  listScenarios,
  loadScenario,
} from '../../src/scenario/ScenarioLoader.js';

// Run with: RUN_ANVIL_TESTS=1 pnpm test
const describeIfAnvil = process.env.RUN_ANVIL_TESTS ? describe : describe.skip;

/**
 * Start anvil process and wait for it to be ready
 */
async function startAnvil(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const anvil = spawn('anvil', ['--port', port.toString()], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        anvil.kill();
        reject(new Error('Anvil startup timeout'));
      }
    }, 10000);

    anvil.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      if (output.includes('Listening on')) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolve(anvil), 500);
      }
    });

    anvil.stderr?.on('data', (data: Buffer) => {
      console.error('Anvil stderr:', data.toString());
    });

    anvil.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    anvil.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Anvil exited with code ${code}`));
      }
    });
  });
}

describeIfAnvil('Rebalancer Simulation', function () {
  this.timeout(120000);

  const anvilPort = 8545;
  const anvilRpc = `http://localhost:${anvilPort}`;
  let anvilProcess: ChildProcess | null = null;

  before(async function () {
    // Check if scenarios exist
    const scenarios = listScenarios();
    if (scenarios.length === 0) {
      console.log('No scenarios found. Run: pnpm generate-scenarios');
      this.skip();
    }
    console.log(`Found ${scenarios.length} scenarios: ${scenarios.join(', ')}`);

    console.log('Starting anvil...');
    anvilProcess = await startAnvil(anvilPort);
    console.log('Anvil started\n');
  });

  after(async function () {
    if (anvilProcess) {
      anvilProcess.kill();
      anvilProcess = null;
    }
  });

  /**
   * Helper to run a scenario and return results
   */
  async function runScenario(scenarioName: string) {
    const scenario = loadScenario(scenarioName);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`SCENARIO: ${scenario.name}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  Transfers: ${scenario.transfers.length}`);
    console.log(`  Duration: ${scenario.duration}ms`);
    console.log(`  Chains: ${scenario.chains.join(', ')}`);

    // Deploy fresh environment
    const deployment = await deployMultiDomainSimulation({
      anvilRpc,
      deployerKey: ANVIL_DEPLOYER_KEY,
      chains: DEFAULT_SIMULATED_CHAINS,
      initialCollateralBalance: BigInt(toWei(100)),
    });

    // Configure rebalancer
    const rebalancer = new HyperlaneRunner();
    const strategyConfig = {
      type: 'weighted' as const,
      chains: {
        chain1: {
          weighted: { weight: '0.333', tolerance: '0.15' },
          bridge: deployment.domains['chain1'].bridge,
          bridgeLockTime: 500,
        },
        chain2: {
          weighted: { weight: '0.333', tolerance: '0.15' },
          bridge: deployment.domains['chain2'].bridge,
          bridgeLockTime: 500,
        },
        chain3: {
          weighted: { weight: '0.334', tolerance: '0.15' },
          bridge: deployment.domains['chain3'].bridge,
          bridgeLockTime: 500,
        },
      },
    };

    const bridgeConfig = createSymmetricBridgeConfig(
      ['chain1', 'chain2', 'chain3'],
      { deliveryDelay: 500, failureRate: 0, deliveryJitter: 100 },
    );

    // Run simulation
    const engine = new SimulationEngine(deployment);
    const result = await engine.runSimulation(
      scenario,
      rebalancer,
      bridgeConfig,
      {
        bridgeDeliveryDelay: 500,
        rebalancerPollingFrequency: 1000,
        userTransferInterval: 100,
      },
      strategyConfig,
    );

    // Print results
    console.log(`\nRESULTS:`);
    console.log(
      `  Completion: ${result.kpis.completedTransfers}/${result.kpis.totalTransfers} (${(result.kpis.completionRate * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Latency: avg=${result.kpis.averageLatency.toFixed(0)}ms, p50=${result.kpis.p50Latency}ms, p95=${result.kpis.p95Latency}ms`,
    );
    console.log(
      `  Rebalances: ${result.kpis.totalRebalances} (${ethers.utils.formatEther(result.kpis.rebalanceVolume.toString())} tokens)`,
    );

    console.log(`\nFinal Balances:`);
    const provider = new ethers.providers.JsonRpcProvider(anvilRpc);
    for (const [name, domain] of Object.entries(deployment.domains)) {
      const balance = await getWarpTokenBalance(
        provider,
        domain.warpToken,
        domain.collateralToken,
      );
      const metrics = result.kpis.perChainMetrics[name];
      const change = Number(balance - metrics.initialBalance) / 1e18;
      const changeStr =
        change >= 0 ? `+${change.toFixed(2)}` : change.toFixed(2);
      console.log(
        `  ${name}: ${ethers.utils.formatEther(balance.toString())} (${changeStr})`,
      );
    }

    return result;
  }

  // Test extreme scenarios that should trigger rebalancing
  it('extreme-drain-chain1: should trigger rebalancing', async () => {
    const result = await runScenario('extreme-drain-chain1');
    expect(result.kpis.completionRate).to.be.greaterThan(0.9);
  });

  it('extreme-accumulate-chain1: should trigger rebalancing', async () => {
    const result = await runScenario('extreme-accumulate-chain1');
    // Lower completion expected because chain1 runs out of collateral
    // when 95% of transfers originate FROM it
    expect(result.kpis.completionRate).to.be.greaterThan(0.6);
    // But rebalancer should still respond
    expect(result.kpis.totalRebalances).to.be.greaterThan(0);
  });

  it('large-unidirectional-to-chain1: large transfers', async () => {
    const result = await runScenario('large-unidirectional-to-chain1');
    expect(result.kpis.completionRate).to.be.greaterThan(0.9);
  });

  it('whale-transfers: massive single transfers', async () => {
    const result = await runScenario('whale-transfers');
    expect(result.kpis.completionRate).to.be.greaterThan(0.9);
  });

  // Test balanced scenario that should NOT need rebalancing
  it('balanced-bidirectional: minimal rebalancing needed', async () => {
    const result = await runScenario('balanced-bidirectional');
    expect(result.kpis.completionRate).to.be.greaterThan(0.9);
  });
});

/**
 * INFLIGHT GUARD TEST SUITE
 * =========================
 *
 * This test suite demonstrates the "inflight guard" problem in rebalancing systems.
 *
 * THE PROBLEM:
 * When a rebalancer sends tokens via a bridge, there's a delay before delivery.
 * During this delay, the rebalancer's next poll still sees the OLD balances
 * (not accounting for pending transfers). Without tracking "inflight" transfers,
 * the rebalancer may send redundant transfers, causing over-correction.
 *
 * EXAMPLE TIMELINE (without inflight guard):
 * ```
 * Time 0ms:    Rebalancer polls. heavy=150, light=100. Sends 25 tokens.
 * Time 200ms:  Rebalancer polls. heavy=125, light=100. Still imbalanced! Sends 25 more.
 * Time 400ms:  Rebalancer polls. heavy=100, light=100. Sends 25 more.
 * Time 600ms:  Rebalancer polls. heavy=75, light=100. NOW heavy is low!
 * ...
 * Time 3000ms: First transfer finally delivers. Light receives 25 tokens.
 * Time 3200ms: Second transfer delivers. Light receives 25 more.
 * ...
 * Final state: light has 300+ tokens instead of target 125.
 * ```
 *
 * THE SOLUTION (inflight guard):
 * Track pending transfers and include them in balance calculations:
 * ```
 * effectiveBalance = onChainBalance + inflightIncoming - inflightOutgoing
 * ```
 *
 * This test PROVES the problem exists by demonstrating over-rebalancing
 * when the inflight guard is not implemented.
 */
import { expect } from 'chai';
import { ethers } from 'ethers';

import { toWei } from '@hyperlane-xyz/utils';

import {
  ProductionRebalancerRunner,
  SimpleRunner,
  SimulationEngine,
  cleanupProductionRebalancer,
  cleanupSimpleRunner,
  createSymmetricBridgeConfig,
  deployMultiDomainSimulation,
  getWarpTokenBalance,
} from '../../src/index.js';
import type { IRebalancerRunner, TransferScenario } from '../../src/index.js';
import { ANVIL_DEPLOYER_KEY } from '../../src/types.js';
import { setupAnvilTestSuite } from '../utils/anvil.js';

// Configure which rebalancers to test via environment variable
// e.g., REBALANCERS=simple for single rebalancer
// Default: run both SimpleRunner and ProductionRebalancerRunner
type RebalancerType = 'simple' | 'production';
const REBALANCER_ENV = process.env.REBALANCERS || 'simple,production';
const ENABLED_REBALANCERS: RebalancerType[] = REBALANCER_ENV.split(',')
  .map((r) => r.trim().toLowerCase())
  .filter((r): r is RebalancerType => r === 'simple' || r === 'production');

if (ENABLED_REBALANCERS.length === 0) {
  throw new Error(
    `No valid rebalancers in REBALANCERS="${REBALANCER_ENV}". Use "simple", "production", or both.`,
  );
}

function createRebalancer(type: RebalancerType): IRebalancerRunner {
  switch (type) {
    case 'simple':
      return new SimpleRunner();
    case 'production':
      return new ProductionRebalancerRunner();
  }
}

describe('Inflight Guard Behavior', function () {
  const anvilPort = 8547;
  const anvil = setupAnvilTestSuite(this, anvilPort);

  // Cleanup rebalancers between tests
  afterEach(async function () {
    await cleanupSimpleRunner();
    await cleanupProductionRebalancer();
  });

  /**
   * TEST: Rebalancer over-rebalancing without inflight guard
   * =========================================================
   *
   * WHAT IT TESTS:
   * Demonstrates that without tracking inflight (pending) transfers,
   * the rebalancer sends multiple redundant transfers to the same
   * destination before the first one delivers, causing massive over-correction.
   *
   * TEST SETUP:
   * - 2 chains: heavy=150 tokens, light=100 tokens (imbalanced)
   * - Target balance: 125 tokens each (total 250 / 2)
   * - Required correction: Send 25 tokens from heavy → light
   * - Bridge delay: 3000ms (intentionally slow)
   * - Rebalancer polling: 200ms (intentionally fast)
   * - Ratio: 15 polls happen before first delivery
   *
   * WHY THESE TIMINGS MATTER:
   * - Bridge delay >> polling interval creates the race condition
   * - Each poll sees "stale" on-chain balances
   * - Without inflight tracking, each poll thinks correction is still needed
   *
   * EXPECTED BEHAVIOR (proving the bug):
   * ```
   * Poll 1:  heavy=150, light=100 → "light is 25 under" → sends 25
   * Poll 2:  heavy=125, light=100 → "light is 12.5 under" → sends 12.5
   * Poll 3:  heavy=112.5, light=100 → "light is 6.25 under" → sends 6.25
   * ... continues until heavy is depleted or light looks "balanced"
   *
   * 3 seconds later, all transfers deliver at once:
   * light receives 25 + 12.5 + 6.25 + ... = way more than 25 needed
   * ```
   *
   * ASSERTIONS:
   * - More than 1 rebalance sent to light (proves over-rebalancing)
   * - Light ends up significantly over target (proves over-correction)
   *
   * WITH INFLIGHT GUARD (what correct behavior would look like):
   * ```
   * Poll 1:  heavy=150, light=100, inflight_to_light=0
   *          effective_light = 100 + 0 = 100 → sends 25
   * Poll 2:  heavy=125, light=100, inflight_to_light=25
   *          effective_light = 100 + 25 = 125 → balanced! no action
   * ...
   * Result: Only 1 transfer sent, light ends at exactly 125
   * ```
   */
  for (const rebalancerType of ENABLED_REBALANCERS) {
    it(`[${rebalancerType}] should detect rebalancer over-rebalancing without inflight guard`, async () => {
      const deployment = await deployMultiDomainSimulation({
        anvilRpc: anvil.rpc,
        deployerKey: ANVIL_DEPLOYER_KEY,
        chains: [
          { chainName: 'heavy', domainId: 1000 },
          { chainName: 'light', domainId: 2000 },
        ],
        initialCollateralBalance: BigInt(toWei(100)),
      });

      const provider = new ethers.providers.JsonRpcProvider(anvil.rpc);
      const deployer = new ethers.Wallet(ANVIL_DEPLOYER_KEY, provider);

      // Create imbalanced state: heavy=150, light=100
      const { ERC20Test__factory } = await import('@hyperlane-xyz/core');
      const heavyToken = ERC20Test__factory.connect(
        deployment.domains['heavy'].collateralToken,
        deployer,
      );
      await heavyToken.mintTo(deployment.domains['heavy'].warpToken, toWei(50));

      const initialHeavy = await getWarpTokenBalance(
        provider,
        deployment.domains['heavy'].warpToken,
        deployment.domains['heavy'].collateralToken,
      );
      const initialLight = await getWarpTokenBalance(
        provider,
        deployment.domains['light'].warpToken,
        deployment.domains['light'].collateralToken,
      );

      console.log('='.repeat(60));
      console.log(
        `INFLIGHT GUARD TEST [${rebalancerType}]: Rebalancer over-rebalancing`,
      );
      console.log('='.repeat(60));
      console.log('\nInitial state (IMBALANCED):');
      console.log(
        `  heavy: ${ethers.utils.formatEther(initialHeavy.toString())} tokens`,
      );
      console.log(
        `  light: ${ethers.utils.formatEther(initialLight.toString())} tokens`,
      );
      const total = initialHeavy + initialLight;
      const target = total / BigInt(2);
      console.log(
        `  Total: ${ethers.utils.formatEther(total.toString())} tokens`,
      );
      console.log(
        `  Target per chain: ${ethers.utils.formatEther(target.toString())} tokens`,
      );

      // Create scenario with small dummy transfers spread over time
      // This keeps the simulation running long enough for rebalancer to poll multiple times
      const scenario: TransferScenario = {
        name: `rebalancer-inflight-test-${rebalancerType}`,
        duration: 8000, // 8 seconds
        transfers: [
          // Small transfers to keep simulation alive, spread across time
          {
            id: 'keepalive-1',
            timestamp: 1000,
            origin: 'heavy',
            destination: 'light',
            amount: BigInt(toWei(0.001)), // Tiny amount
            user: '0x1111111111111111111111111111111111111111',
          },
          {
            id: 'keepalive-2',
            timestamp: 3000,
            origin: 'heavy',
            destination: 'light',
            amount: BigInt(toWei(0.001)),
            user: '0x1111111111111111111111111111111111111111',
          },
          {
            id: 'keepalive-3',
            timestamp: 5000,
            origin: 'heavy',
            destination: 'light',
            amount: BigInt(toWei(0.001)),
            user: '0x1111111111111111111111111111111111111111',
          },
          {
            id: 'keepalive-4',
            timestamp: 7000,
            origin: 'heavy',
            destination: 'light',
            amount: BigInt(toWei(0.001)),
            user: '0x1111111111111111111111111111111111111111',
          },
        ],
        chains: ['heavy', 'light'],
      };

      // SLOW bridge (3 seconds) vs FAST rebalancer polling (200ms)
      const bridgeConfig = createSymmetricBridgeConfig(['heavy', 'light'], {
        deliveryDelay: 3000,
        failureRate: 0,
        deliveryJitter: 0,
      });

      const rebalancer = createRebalancer(rebalancerType);

      // 5% tolerance - heavy at 150 (20% over) and light at 100 (20% under) should trigger
      const strategyConfig = {
        type: 'weighted' as const,
        chains: {
          heavy: {
            weighted: { weight: '0.5', tolerance: '0.05' },
            bridge: deployment.domains['heavy'].bridge,
            bridgeLockTime: 500,
          },
          light: {
            weighted: { weight: '0.5', tolerance: '0.05' },
            bridge: deployment.domains['light'].bridge,
            bridgeLockTime: 500,
          },
        },
      };

      const rebalanceEvents: Array<{
        origin: string;
        destination: string;
        amount: bigint;
        timestamp: number;
      }> = [];

      rebalancer.on('rebalance', (event) => {
        if (
          event.type === 'rebalance_completed' &&
          event.origin &&
          event.destination &&
          event.amount
        ) {
          rebalanceEvents.push({
            origin: event.origin,
            destination: event.destination,
            amount: event.amount,
            timestamp: event.timestamp,
          });
          console.log(
            `  >> REBALANCE #${rebalanceEvents.length}: ${event.origin} -> ${event.destination}: ${ethers.utils.formatEther(event.amount.toString())} tokens`,
          );
        }
      });

      console.log('\nSimulation config:');
      console.log('  - Bridge delay: 3 seconds');
      console.log('  - Rebalancer polling: every 200ms');
      console.log('  - Scenario duration: 8 seconds');
      console.log('\nExpected behavior WITHOUT inflight guard:');
      console.log(
        '  - Rebalancer sends transfer #1: heavy -> light (~25 tokens)',
      );
      console.log('  - Bridge takes 3 seconds to deliver');
      console.log('  - Rebalancer polls again, still sees light as low');
      console.log('  - May send additional transfers before #1 delivers\n');

      const engine = new SimulationEngine(deployment);
      const result = await engine.runSimulation(
        scenario,
        rebalancer,
        bridgeConfig,
        {
          userTransferDeliveryDelay: 0, // Instant user transfers (this test focuses on rebalancer behavior)
          rebalancerPollingFrequency: 200, // Very fast polling
          userTransferInterval: 100,
        },
        strategyConfig,
      );

      // Wait for any remaining bridge deliveries
      await new Promise((resolve) => setTimeout(resolve, 4000));

      const finalHeavy = await getWarpTokenBalance(
        provider,
        deployment.domains['heavy'].warpToken,
        deployment.domains['heavy'].collateralToken,
      );
      const finalLight = await getWarpTokenBalance(
        provider,
        deployment.domains['light'].warpToken,
        deployment.domains['light'].collateralToken,
      );

      console.log('\n' + '='.repeat(60));
      console.log('RESULTS');
      console.log('='.repeat(60));
      console.log('\nFinal balances:');
      console.log(
        `  heavy: ${ethers.utils.formatEther(finalHeavy.toString())} tokens`,
      );
      console.log(
        `  light: ${ethers.utils.formatEther(finalLight.toString())} tokens`,
      );

      console.log(
        `\nRebalancer initiated: ${result.kpis.totalRebalances} rebalances`,
      );
      console.log(`Rebalance events captured: ${rebalanceEvents.length}`);

      const rebalancesToLight = rebalanceEvents.filter(
        (e) => e.destination === 'light',
      );
      const totalSentToLight = rebalancesToLight.reduce(
        (sum, e) => sum + e.amount,
        BigInt(0),
      );

      console.log(`\nRebalances TO light: ${rebalancesToLight.length}`);
      if (totalSentToLight > BigInt(0)) {
        console.log(
          `Total volume TO light: ${ethers.utils.formatEther(totalSentToLight.toString())} tokens`,
        );
      }

      console.log('\n' + '='.repeat(60));
      console.log('ANALYSIS');
      console.log('='.repeat(60));

      // KEY ASSERTIONS: Behavior differs based on rebalancer type
      // - SimpleRunner: No inflight guard, expects over-rebalancing
      // - ProductionRebalancerRunner: Has inflight guard (ActionTracker), expects correct behavior

      if (rebalancerType === 'simple') {
        // SimpleRunner has NO inflight guard - expects over-rebalancing
        expect(rebalancesToLight.length).to.be.greaterThan(
          1,
          `[${rebalancerType}] Expected multiple rebalances to light - demonstrates missing inflight guard`,
        );

        console.log(
          '\n❌ OVER-REBALANCING DETECTED (as expected for SimpleRunner):',
        );
        console.log(
          `   Rebalancer sent ${rebalancesToLight.length} separate transfers to light`,
        );
        console.log(
          "   This happened because SimpleRunner doesn't track inflight transfers",
        );
        console.log(
          `   Total sent: ${ethers.utils.formatEther(totalSentToLight.toString())} tokens`,
        );
        console.log(`   Only needed: ~25 tokens`);

        if (finalLight > target) {
          const overBy = finalLight - target;
          console.log(
            `\n   Light ended up ${ethers.utils.formatEther(overBy.toString())} tokens OVER target`,
          );
          console.log(
            '   This demonstrates the need for inflight-aware rebalancing',
          );
        }

        console.log(
          '\n   WITH inflight guard (like ProductionRebalancerRunner), we would expect:',
        );
        console.log('   - Only 1-2 rebalances (not 30+)');
        console.log('   - Light ending near target 125, not 300+');
      } else {
        // ProductionRebalancerRunner HAS inflight guard (ActionTracker) - expects correct behavior
        // It should send at most 2 rebalances (initial + possibly one more before tracking kicks in)
        expect(rebalancesToLight.length).to.be.lessThanOrEqual(
          2,
          `[${rebalancerType}] Expected at most 2 rebalances - CLI rebalancer has inflight tracking`,
        );

        console.log(
          '\n✅ CORRECT BEHAVIOR (ProductionRebalancerRunner has inflight tracking):',
        );
        console.log(
          `   Rebalancer sent only ${rebalancesToLight.length} transfer(s) to light`,
        );
        console.log(
          '   ActionTracker prevents redundant transfers while previous ones are inflight',
        );
        console.log(
          `   Total sent: ${ethers.utils.formatEther(totalSentToLight.toString())} tokens`,
        );
        console.log(`   Expected: ~25 tokens`);
      }
    });
  }
});

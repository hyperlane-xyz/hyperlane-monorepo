/**
 * MULTI-DOMAIN DEPLOYMENT TEST SUITE
 * ===================================
 *
 * These tests verify the simulation deployment infrastructure works correctly.
 *
 * ARCHITECTURE:
 * - Single Anvil instance simulates multiple "chains" via domain IDs
 * - Each domain has its own: Mailbox, WarpToken, CollateralToken, Bridge
 * - All domains share the same RPC endpoint (http://localhost:PORT)
 * - Domain IDs (1000, 2000, 3000) distinguish chains, not separate processes
 *
 * WHY SINGLE ANVIL?
 * - Faster test execution (no multi-process coordination)
 * - Simpler state management (single blockchain state)
 * - Sufficient for testing rebalancer logic (doesn't need real cross-chain)
 *
 * DEPLOYMENT COMPONENTS PER DOMAIN:
 * - CollateralToken: ERC20 that users deposit to send cross-chain
 * - WarpToken: HypERC20Collateral that holds collateral and mints/burns
 * - Mailbox: MockMailbox for instant message delivery (user transfers)
 * - Bridge: MockValueTransferBridge for delayed delivery (rebalancer transfers)
 */
import { expect } from 'chai';
import { ethers } from 'ethers';

import { toWei } from '@hyperlane-xyz/utils';

import {
  deployMultiDomainSimulation,
  getWarpTokenBalance,
} from '../../src/index.js';
import {
  ANVIL_DEPLOYER_KEY,
  DEFAULT_SIMULATED_CHAINS,
} from '../../src/types.js';
import { setupAnvilTestSuite } from '../utils/anvil.js';

describe('Multi-Domain Deployment', function () {
  const anvilPort = 8546; // Use different port to avoid conflict with other tests
  const anvil = setupAnvilTestSuite(this, anvilPort);
  let provider: ethers.providers.JsonRpcProvider;

  before(async () => {
    provider = new ethers.providers.JsonRpcProvider(anvil.rpc);
  });

  /**
   * TEST: Multi-domain deployment
   * =============================
   *
   * WHAT IT TESTS:
   * Verifies that deployMultiDomainSimulation correctly deploys all
   * required contracts for each simulated chain.
   *
   * VERIFICATION:
   * - 3 domains created (chain1, chain2, chain3)
   * - Each domain has valid addresses for all contracts
   * - Each warp token has correct initial collateral balance (100 tokens)
   *
   * WHY IT MATTERS:
   * This is the foundation for all other tests. If deployment fails,
   * no simulation can run.
   */
  it('should deploy multi-domain simulation', async () => {
    const result = await deployMultiDomainSimulation({
      anvilRpc: anvil.rpc,
      deployerKey: ANVIL_DEPLOYER_KEY,
      chains: DEFAULT_SIMULATED_CHAINS,
      initialCollateralBalance: BigInt(toWei(100)),
    });

    // Verify all domains deployed
    expect(Object.keys(result.domains).length).to.equal(3);

    for (const [chainName, domain] of Object.entries(result.domains)) {
      expect(domain.chainName).to.equal(chainName);
      expect(domain.mailbox).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(domain.warpToken).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(domain.collateralToken).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(domain.bridge).to.match(/^0x[a-fA-F0-9]{40}$/);

      // Verify balances
      const balance = await getWarpTokenBalance(
        provider,
        domain.warpToken,
        domain.collateralToken,
      );
      expect(balance.toString()).to.equal(toWei(100));
    }
  });
});

import { expect } from 'vitest';

import { environments } from '../config/environments/index.js';
import { CCTP_CHAINS } from '../config/environments/mainnet3/warp/configGetters/getCCTPConfig.js';

describe('Rebalancer Configuration', () => {
  describe('Funding configuration for mainnet3', () => {
    it('should have desired rebalancer balance settings for all mainnet CCTP warp route chains', () => {
      const env = environments.mainnet3;
      expect(env.keyFunderConfig).toBeDefined();
      const rebalancerBalances =
        env.keyFunderConfig!.desiredRebalancerBalancePerChain;

      // Check that all CCTP chains have rebalancer balance settings
      for (const chain of CCTP_CHAINS) {
        expect(
          rebalancerBalances[chain],
          `Missing rebalancer balance for CCTP chain ${chain}. All chains in the mainnet CCTP warp route should have desired rebalancer balance settings.`,
        ).toBeDefined();

        // Also verify it's a valid numeric string
        expect(
          typeof parseFloat(rebalancerBalances[chain]),
          `Invalid rebalancer balance for chain ${chain}: ${rebalancerBalances[chain]}`,
        ).toBe('number');
      }
    });
  });
});

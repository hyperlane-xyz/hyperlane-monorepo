import { expect } from 'chai';

import { DEFAULT_E2E_TEST_TIMEOUT } from '../commands/helpers.js';
import { hyperlaneWarpRebalancer } from '../commands/warp.js';

describe('hyperlane warp rebalancer e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  describe('hyperlane warp rebalancer', () => {
    it('should successfully start the warp route collateral rebalancer', async function () {
      // Run the rebalancer command
      const output = await hyperlaneWarpRebalancer().stdio('pipe');

      // Verify the output contains the expected header and success message
      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('Hyperlane Warp Rebalancer');
      expect(output.text()).to.include('ok');
    });
  });
});

import { expect } from 'chai';

import { sleep } from '@hyperlane-xyz/utils';

import { DEFAULT_E2E_TEST_TIMEOUT } from '../commands/helpers.js';
import { hyperlaneWarpRebalancer } from '../commands/warp.js';

describe('hyperlane warp rebalancer e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  describe('hyperlane warp rebalancer', () => {
    it('should successfully start and stop the warp rebalancer', async function () {
      // Start the process
      const process = hyperlaneWarpRebalancer().stdio('pipe');

      // Wait for the process to start
      await sleep(5000);

      // Stop the process
      await process.kill('SIGINT');

      // Wait for the process to stop
      await sleep(1000);

      // Get the output
      const text = await process.text();

      // Verify the output contains the expected messages
      expect(text).to.include('Starting rebalancer ...');
      expect(text).to.include('Stopping rebalancer ...');
    });
  });
});

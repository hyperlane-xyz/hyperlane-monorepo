import { StartedTestContainer } from 'testcontainers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_E2E_TEST_TIMEOUT } from '../testing/constants.js';
import { runStarknetNode } from '../testing/node.js';

const SETUP_TIMEOUT = 2 * DEFAULT_E2E_TEST_TIMEOUT;

const TESTS_WITHOUT_DEVNET = new Set(['read-warp-token']);
const SKIP_DEVNET = TESTS_WITHOUT_DEVNET.has(
  process.env['STARKNET_SDK_E2E_TEST'] ?? '',
);

let starknetNode: StartedTestContainer | undefined;

before(async function () {
  if (SKIP_DEVNET) return;
  this.timeout(SETUP_TIMEOUT);
  rootLogger.info('Starting Starknet devnet for e2e tests');
  starknetNode = await runStarknetNode();
});

after(async function () {
  if (SKIP_DEVNET) return;
  this.timeout(SETUP_TIMEOUT);

  if (starknetNode) {
    rootLogger.info('Stopping Starknet devnet for e2e tests');
    await starknetNode.stop();
  }
});

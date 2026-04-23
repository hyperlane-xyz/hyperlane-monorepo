import { StartedTestContainer } from 'testcontainers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { runStarknetNode } from '../testing/node.js';

const TESTS_WITHOUT_DEVNET = new Set(['read-warp-token']);
const SKIP_DEVNET = TESTS_WITHOUT_DEVNET.has(
  process.env['STARKNET_SDK_E2E_TEST'] ?? '',
);

let starknetNode: StartedTestContainer | undefined;

export default async function setup() {
  if (SKIP_DEVNET) return;
  rootLogger.info('Starting Starknet devnet for e2e tests');
  starknetNode = await runStarknetNode();

  return async () => {
    if (starknetNode) {
      rootLogger.info('Stopping Starknet devnet for e2e tests');
      await starknetNode.stop();
    }
  };
}

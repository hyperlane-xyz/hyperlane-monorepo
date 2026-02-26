import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_COSMOS_CHAIN_METADATA,
} from '../testing/constants.js';
import { runCosmosNode } from '../testing/node.js';

let cosmosNodeInstance: Awaited<ReturnType<typeof runCosmosNode>>;

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  cosmosNodeInstance = await runCosmosNode(TEST_COSMOS_CHAIN_METADATA);
});

after(async function () {
  if (cosmosNodeInstance) {
    await cosmosNodeInstance.stop();
  }
});

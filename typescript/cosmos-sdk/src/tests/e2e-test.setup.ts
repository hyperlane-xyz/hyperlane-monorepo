import { TEST_COSMOS_CHAIN_METADATA } from '../testing/constants.js';
import { runCosmosNode } from '../testing/node.js';

export default async function () {
  const instance = await runCosmosNode(TEST_COSMOS_CHAIN_METADATA);
  return async () => {
    await instance.stop();
  };
}

import { hyperlaneCoreDeploy } from './commands/core.js';
import {
  REGISTRY_PATH,
  hyperlaneRelayer,
  hyperlaneSendMessage,
} from './commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from './commands/warp.js';

const CHAIN_NAME_1 = 'anvil2';
const CHAIN_NAME_2 = 'anvil3';

const SYMBOL = 'ETH';

const WARP_DEPLOY_OUTPUT = `${REGISTRY_PATH}/deployments/warp_routes/${SYMBOL}/${CHAIN_NAME_1}-${CHAIN_NAME_2}-config.yaml`;

const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
const WARP_CONFIG_PATH = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;

const TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while
describe('hyperlane relayer e2e tests', async function () {
  this.timeout(TEST_TIMEOUT);

  before(async () => {
    await hyperlaneCoreDeploy(CHAIN_NAME_1, CORE_CONFIG_PATH);
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);

    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);
  });

  describe('relayer', () => {
    it('should relay core messages', async () => {
      const { abortController } = hyperlaneRelayer([
        CHAIN_NAME_1,
        CHAIN_NAME_2,
      ]);

      await hyperlaneSendMessage(CHAIN_NAME_1, CHAIN_NAME_2);
      await hyperlaneSendMessage(CHAIN_NAME_2, CHAIN_NAME_1);

      abortController.abort();
    });

    it('should relay warp messages', async () => {
      const { abortController } = hyperlaneRelayer(
        [CHAIN_NAME_1, CHAIN_NAME_2],
        SYMBOL,
      );

      await hyperlaneWarpSendRelay(
        CHAIN_NAME_1,
        CHAIN_NAME_2,
        WARP_DEPLOY_OUTPUT,
        false,
      );
      await hyperlaneWarpSendRelay(
        CHAIN_NAME_2,
        CHAIN_NAME_1,
        WARP_DEPLOY_OUTPUT,
        false,
      );
      abortController.abort();
    });
  });
});

import { TokenType } from '@hyperlane-xyz/sdk';

import { writeYamlOrJson } from '../../utils/files.js';

import { hyperlaneCoreDeploy } from './commands/core.js';
import {
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
  hyperlaneRelayer,
  hyperlaneSendMessage,
} from './commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from './commands/warp.js';

const SYMBOL = 'ETH';
const WARP_DEPLOY_OUTPUT = `${REGISTRY_PATH}/deployments/warp_routes/${SYMBOL}/${CHAIN_NAME_3}-config.yaml`;

describe('hyperlane relayer e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  before(async () => {
    await Promise.all([
      hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH),
      hyperlaneCoreDeploy(CHAIN_NAME_3, CORE_CONFIG_PATH),
    ]);

    const warpConfig = {
      anvil2: {
        type: TokenType.native,
        symbol: SYMBOL,
      },
      anvil3: {
        type: TokenType.synthetic,
        symbol: SYMBOL,
      },
    };

    const warpConfigPath = `./${TEMP_PATH}/warp-route-config.yaml`;
    writeYamlOrJson(warpConfigPath, warpConfig);
    await hyperlaneWarpDeploy(warpConfigPath);
  });

  describe('relayer', () => {
    it('should relay core messages', async () => {
      const process = hyperlaneRelayer([CHAIN_NAME_2, CHAIN_NAME_3]);

      await hyperlaneSendMessage(CHAIN_NAME_2, CHAIN_NAME_3);
      await hyperlaneSendMessage(CHAIN_NAME_3, CHAIN_NAME_2);

      await process.kill('SIGINT');
    });

    it('should relay warp messages', async () => {
      const process = hyperlaneRelayer(
        [CHAIN_NAME_2, CHAIN_NAME_3],
        WARP_DEPLOY_OUTPUT,
      );

      await hyperlaneWarpSendRelay(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        WARP_DEPLOY_OUTPUT,
        false,
      );
      await hyperlaneWarpSendRelay(
        CHAIN_NAME_3,
        CHAIN_NAME_2,
        WARP_DEPLOY_OUTPUT,
        false,
      );

      await process.kill('SIGINT');
    });
  });
});

import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import { TokenType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  getWarpCoreConfigPath,
} from '../../constants.js';
import { hyperlaneRelayer, hyperlaneSendMessage } from '../commands/helpers.js';

const SYMBOL = 'ETH';
const WARP_ID = createWarpRouteConfigId(
  SYMBOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
);
const WARP_DEPLOY_OUTPUT = getWarpCoreConfigPath(SYMBOL, [
  TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
]);

describe('hyperlane relayer e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    `${TEMP_PATH}/${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2}/core-config-read.yaml`,
  );

  const evmChain3Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    `${TEMP_PATH}/${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3}/core-config-read.yaml`,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    `${TEMP_PATH}/warp-route-deployment.yaml`,
  );

  before(async () => {
    await Promise.all([
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain3Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);
  });

  describe('relayer', () => {
    it('should relay core messages', async () => {
      const process = hyperlaneRelayer([
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      ]);

      await hyperlaneSendMessage(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      );
      await hyperlaneSendMessage(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      );

      await process.kill('SIGINT');
    });

    it('should relay warp messages', async () => {
      const warpConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.native,
          symbol: SYMBOL,
        },
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          symbol: SYMBOL,
        },
      };

      const warpConfigPath = `${TEMP_PATH}/warp-route-config.yaml`;
      writeYamlOrJson(warpConfigPath, warpConfig);

      await evmWarpCommands.deploy(
        warpConfigPath,
        HYP_KEY_BY_PROTOCOL.ethereum,
        WARP_ID,
      );

      const process = hyperlaneRelayer(
        [
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        ],
        WARP_DEPLOY_OUTPUT,
      );

      await evmWarpCommands.sendAndRelay({
        origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        warpCorePath: WARP_DEPLOY_OUTPUT,
        relay: false,
        privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });
      await evmWarpCommands.sendAndRelay({
        origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        warpCorePath: WARP_DEPLOY_OUTPUT,
        relay: false,
        privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      await process.kill('SIGINT');
    });
  });
});

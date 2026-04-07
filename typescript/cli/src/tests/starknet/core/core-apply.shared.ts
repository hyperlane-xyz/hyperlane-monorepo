import { type CoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  STARKNET_E2E_TEST_TIMEOUT,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';

export function describeStarknetCoreApplyTest(
  description: string,
  test: (hyperlaneCore: HyperlaneE2ECoreTestCommands) => Promise<void>,
) {
  describe('hyperlane core apply (Starknet E2E tests)', function () {
    this.timeout(STARKNET_E2E_TEST_TIMEOUT);

    const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Starknet,
      TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      REGISTRY_PATH,
      CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    );

    beforeEach(async () => {
      const coreConfig: CoreConfig = readYamlOrJson(
        CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
      );
      writeYamlOrJson(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
        coreConfig,
      );
      hyperlaneCore.setCoreInputPath(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      );
      await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.starknet);
    });

    it(description, async () => {
      await test(hyperlaneCore);
    });
  });
}

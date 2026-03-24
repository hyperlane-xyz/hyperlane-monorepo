import { ProtocolType } from '@hyperlane-xyz/utils';

import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  STARKNET_E2E_TEST_TIMEOUT,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';
import { expectStarknetCoreConfig } from '../helpers.js';

describe('hyperlane starknet core read e2e tests', async function () {
  this.timeout(STARKNET_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  );

  before(async () => {
    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.starknet);
  });

  it('should read a Starknet core deployment', async () => {
    const coreConfig = await hyperlaneCore.readConfig();
    expectStarknetCoreConfig(coreConfig, {
      mailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      defaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      defaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      protocolFee: '10',
    });
  });
});

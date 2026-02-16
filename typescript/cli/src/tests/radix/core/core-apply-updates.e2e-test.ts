import { ProtocolType } from '@hyperlane-xyz/utils';

import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';
import { createCoreUpdateTests } from '../../helpers/core-ism-hook-test-factory.js';

describe('hyperlane core apply ISM/Hook updates (Radix E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Radix,
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.radix,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
  );

  createCoreUpdateTests(
    {
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
      baseCoreConfigPath: CORE_CONFIG_PATH_BY_PROTOCOL.radix,
      coreApplyConfigPath: CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
      privateKey: HYP_KEY_BY_PROTOCOL.radix,
      alternateOwnerAddress: BURN_ADDRESS_BY_PROTOCOL.radix,
    },
    hyperlaneCore,
  );
});

import { expect } from 'chai';

import { type CoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
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

describe('hyperlane core apply mailbox (Aleo E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Aleo,
    TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
  );

  // Reset the core deploy config before each test
  beforeEach(async function () {
    const coreConfig: CoreConfig = await readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
    );
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
      coreConfig,
    );

    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
    );

    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.aleo);
  });

  it(`should update the mailbox owner to the specified one`, async () => {
    const coreConfig: CoreConfig = await readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
    );

    coreConfig.owner = BURN_ADDRESS_BY_PROTOCOL.aleo;
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
      coreConfig,
    );

    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.aleo);

    const derivedCoreConfig = await hyperlaneCore.readConfig();
    expect(derivedCoreConfig.owner).to.equal(BURN_ADDRESS_BY_PROTOCOL.aleo);
  });
});

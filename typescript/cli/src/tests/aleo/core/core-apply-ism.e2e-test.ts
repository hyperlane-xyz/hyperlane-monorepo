import { expect } from 'chai';

import {
  type CoreConfig,
  type IsmConfig,
  IsmType,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, normalizeConfig } from '@hyperlane-xyz/utils';

import {
  readYamlOrJsonOrThrow,
  writeYamlOrJson,
} from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';

describe('hyperlane core apply ism (Aleo E2E tests)', async function () {
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
    const coreConfig = readYamlOrJsonOrThrow<CoreConfig>(
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

  const testCases: Partial<Record<IsmType, Exclude<IsmConfig, string>>> = {
    [IsmType.TEST_ISM]: {
      type: IsmType.TEST_ISM,
    },
    [IsmType.MESSAGE_ID_MULTISIG]: {
      type: IsmType.MESSAGE_ID_MULTISIG,
      threshold: 1,
      validators: [randomAddress()],
    },
    [IsmType.ROUTING]: {
      type: IsmType.ROUTING,
      domains: {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_2]: {
          type: IsmType.TEST_ISM,
        },
      },
      owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
    },
  };

  for (const ismConfig of Object.values(testCases)) {
    it(`should update the defaultIsm to a ${ismConfig.type}`, async () => {
      const coreConfig = readYamlOrJsonOrThrow<CoreConfig>(
        CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
      );

      coreConfig.defaultIsm = ismConfig;
      writeYamlOrJson(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
        coreConfig,
      );

      await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.aleo);

      const derivedCoreConfig = await hyperlaneCore.readConfig();

      const derivedIsmConfig = derivedCoreConfig.defaultIsm;
      expect(derivedIsmConfig.type).to.equal(ismConfig.type);

      expect(normalizeConfig(derivedIsmConfig)).to.deep.equal(
        normalizeConfig(ismConfig),
      );
    });
  }
});

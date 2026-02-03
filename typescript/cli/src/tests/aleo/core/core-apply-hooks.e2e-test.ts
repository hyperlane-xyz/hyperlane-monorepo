import { expect } from 'chai';

import { type CoreConfig, type HookConfig, HookType } from '@hyperlane-xyz/sdk';
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

describe('hyperlane core apply hooks (Aleo E2E tests)', async function () {
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

  type CoreConfigField = keyof CoreConfig;

  const testCases: Partial<Record<HookType, Exclude<HookConfig, string>>> = {
    [HookType.MERKLE_TREE]: {
      type: HookType.MERKLE_TREE,
    },
    [HookType.INTERCHAIN_GAS_PAYMASTER]: {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      beneficiary: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
      oracleConfig: {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1]: {
          gasPrice: '1',
          tokenExchangeRate: '3',
        },
      },
      oracleKey: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
      overhead: {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1]: 1,
      },
      owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
    },
  };

  const hookFields = [
    'requiredHook',
    'defaultHook',
  ] as const satisfies CoreConfigField[];

  for (const hookConfig of Object.values(testCases)) {
    for (const hookField of hookFields) {
      it(`should update the ${hookField} to a ${hookConfig.type}`, async () => {
        const coreConfig = readYamlOrJsonOrThrow<CoreConfig>(
          CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
        );

        coreConfig[hookField] = hookConfig;
        writeYamlOrJson(
          CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
          coreConfig,
        );

        await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.aleo);

        const derivedCoreConfig = await hyperlaneCore.readConfig();

        const derivedHookConfig = derivedCoreConfig[hookField];
        expect(derivedHookConfig.type).to.equal(hookConfig.type);

        expect(normalizeConfig(derivedHookConfig)).to.deep.equal(
          normalizeConfig(hookConfig),
        );
      });
    }
  }
});

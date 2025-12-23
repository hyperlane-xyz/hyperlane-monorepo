import { expect } from 'chai';

import {
  CoreConfig,
  HookConfig,
  HookType,
  IsmConfig,
  IsmType,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, normalizeConfig } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';

describe('hyperlane core apply (Radix E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Radix,
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.radix,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
  );

  // Reset the core deploy config before each test
  beforeEach(async function () {
    const coreConfig: CoreConfig = await readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.radix,
    );
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
      coreConfig,
    );

    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
    );

    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.radix);
  });

  type CoreConfigField = keyof CoreConfig;

  describe('hyperlane core apply (mailbox updates)', function () {
    it(`should update the mailbox owner to the specified one`, async () => {
      const coreConfig: CoreConfig = await readYamlOrJson(
        CORE_CONFIG_PATH_BY_PROTOCOL.radix,
      );

      coreConfig.owner = BURN_ADDRESS_BY_PROTOCOL.radix;
      writeYamlOrJson(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
        coreConfig,
      );

      await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.radix);

      const derivedCoreConfig = await hyperlaneCore.readConfig();
      expect(derivedCoreConfig.owner).to.equal(BURN_ADDRESS_BY_PROTOCOL.radix);
    });
  });

  describe('hyperlane core apply (hook updates)', function () {
    const testCases: Partial<Record<HookType, Exclude<HookConfig, string>>> = {
      [HookType.MERKLE_TREE]: {
        type: HookType.MERKLE_TREE,
      },
      [HookType.INTERCHAIN_GAS_PAYMASTER]: {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        beneficiary: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        oracleConfig: {
          [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2]: {
            gasPrice: '1',
            tokenDecimals: 18,
            tokenExchangeRate: '3',
          },
        },
        oracleKey: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        overhead: {
          [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2]: 1,
        },
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
      },
    };

    const hookFields = [
      'requiredHook',
      'defaultHook',
    ] as const satisfies CoreConfigField[];

    for (const hookConfig of Object.values(testCases)) {
      for (const hookField of hookFields) {
        it(`should update the ${hookField} to a ${hookConfig.type}`, async () => {
          const coreConfig: CoreConfig = await readYamlOrJson(
            CORE_CONFIG_PATH_BY_PROTOCOL.radix,
          );

          coreConfig[hookField] = hookConfig;
          writeYamlOrJson(
            CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
            coreConfig,
          );

          await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.radix);

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

  describe('hyperlane core apply (ism updates)', function () {
    const testCases: Partial<Record<IsmType, Exclude<IsmConfig, string>>> = {
      [IsmType.TEST_ISM]: {
        type: IsmType.TEST_ISM,
      },
      [IsmType.MESSAGE_ID_MULTISIG]: {
        type: IsmType.MESSAGE_ID_MULTISIG,
        threshold: 1,
        validators: [randomAddress()],
      },
      [IsmType.MERKLE_ROOT_MULTISIG]: {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        threshold: 1,
        validators: [randomAddress()],
      },
      [IsmType.ROUTING]: {
        type: IsmType.ROUTING,
        domains: {
          [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2]: {
            type: IsmType.TEST_ISM,
          },
        },
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
      },
    };

    for (const ismConfig of Object.values(testCases)) {
      it(`should update the defaultIsm to a ${ismConfig.type}`, async () => {
        const coreConfig: CoreConfig = await readYamlOrJson(
          CORE_CONFIG_PATH_BY_PROTOCOL.radix,
        );

        coreConfig.defaultIsm = ismConfig;
        writeYamlOrJson(
          CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
          coreConfig,
        );

        await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.radix);

        const derivedCoreConfig = await hyperlaneCore.readConfig();

        const derivedIsmConfig = derivedCoreConfig.defaultIsm;
        expect(derivedIsmConfig.type).to.equal(ismConfig.type);

        expect(normalizeConfig(derivedIsmConfig)).to.deep.equal(
          normalizeConfig(ismConfig),
        );
      });
    }
  });
});

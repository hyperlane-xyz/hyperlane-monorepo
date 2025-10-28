import { expect } from 'chai';

import {
  CoreConfig,
  DerivedCoreConfig,
  HookType,
  IsmType,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

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

describe('hyperlane core deploy (Radix E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Radix,
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.radix,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
  );

  type CoreConfigOwnershipAssertion = {
    expectedMailboOwner: Address;
    expectedDefaultHookOwner: Address;
    expectedDefaultIsmOwner: Address;
  };

  function assertTestRadixCoreConfig(
    coreConfig: DerivedCoreConfig,
    options: CoreConfigOwnershipAssertion,
  ) {
    expect(coreConfig.owner).to.equal(options.expectedMailboOwner);
    expect(coreConfig.proxyAdmin?.owner).to.be.undefined;

    const deployedDefaultHook = coreConfig.defaultHook;
    assert(
      deployedDefaultHook.type === HookType.INTERCHAIN_GAS_PAYMASTER,
      `Expected deployed defaultHook to be of type ${HookType.INTERCHAIN_GAS_PAYMASTER}`,
    );
    expect(deployedDefaultHook.beneficiary).to.equal(
      options.expectedDefaultHookOwner,
    );
    expect(deployedDefaultHook.oracleKey).to.equal(
      options.expectedDefaultHookOwner,
    );

    const deployedRequiredHook = coreConfig.requiredHook;
    assert(
      deployedRequiredHook.type === HookType.MERKLE_TREE,
      `Expected deployed requiredHook to be of type ${HookType.MERKLE_TREE}`,
    );

    const deployedDefaultIsm = coreConfig.defaultIsm;
    assert(
      deployedDefaultIsm.type === IsmType.ROUTING,
      `Expected deployed defaultIsm to be of type ${HookType.MERKLE_TREE}`,
    );
    expect(deployedDefaultIsm.owner).to.equal(options.expectedDefaultIsmOwner);
  }

  describe('hyperlane core deploy --yes --key ...', () => {
    const testCases: {
      description: string;
      expect: CoreConfigOwnershipAssertion;
    }[] = [
      {
        description:
          'should create a core deployment with the signer as the mailbox owner',
        expect: {
          expectedDefaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedDefaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedMailboOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the mailbox',
        expect: {
          expectedDefaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedDefaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedMailboOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the defaultHook',
        expect: {
          expectedDefaultHookOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
          expectedDefaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedMailboOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        },
      },
      // TODO: fix this as it seems that the ism address is not set on deployment
      // {
      //   description:
      //     'should create a core deployment with the provided address as the owner of the defaultIsm',
      //   expect: {
      //     expectedDefaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
      //     expectedDefaultIsmOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
      //     expectedMailboOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
      //   },
      // },
    ];

    for (const { description, expect } of testCases) {
      it(description, async () => {
        const coreConfig: CoreConfig = await readYamlOrJson(
          CORE_CONFIG_PATH_BY_PROTOCOL.radix,
        );

        coreConfig.owner = expect.expectedMailboOwner;

        const defaultHookConfig = coreConfig.defaultHook;
        assert(
          typeof defaultHookConfig !== 'string' &&
            defaultHookConfig.type === HookType.INTERCHAIN_GAS_PAYMASTER,
          `Expected defaultHook in deploy config to be of type ${HookType.INTERCHAIN_GAS_PAYMASTER}`,
        );
        defaultHookConfig.owner = expect.expectedDefaultHookOwner;

        const defaultIsmConfig = coreConfig.defaultIsm;
        assert(
          typeof defaultIsmConfig !== 'string' &&
            defaultIsmConfig.type === IsmType.ROUTING,
          `Expected defaultIsm in deploy config to be of type ${IsmType.ROUTING}`,
        );
        defaultIsmConfig.owner = expect.expectedDefaultIsmOwner;

        coreConfig.defaultHook = defaultHookConfig;
        coreConfig.defaultIsm = defaultIsmConfig;

        writeYamlOrJson(
          CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
          coreConfig,
        );
        hyperlaneCore.setCoreInputPath(
          CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
        );

        await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.radix);

        const derivedCoreConfig = await hyperlaneCore.readConfig();

        assertTestRadixCoreConfig(derivedCoreConfig, expect);
      });
    }
  });
});

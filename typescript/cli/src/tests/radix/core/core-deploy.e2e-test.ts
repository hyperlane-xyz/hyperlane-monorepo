import { expect } from 'chai';

import {
  CoreConfig,
  DerivedCoreConfig,
  HookType,
  IsmType,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, assert, objLength } from '@hyperlane-xyz/utils';

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
    expectedMailboxOwner: Address;
    expectedDefaultHookOwner: Address;
    expectedDefaultIsmOwner: Address;
  };

  // see typescript/cli/examples/radix/core-config.yaml
  function assertTestRadixCoreConfig(
    coreConfig: DerivedCoreConfig,
    options: CoreConfigOwnershipAssertion,
  ) {
    expect(coreConfig.owner).to.equal(options.expectedMailboxOwner);
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

    const gasConfig =
      deployedDefaultHook.oracleConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2
      ];
    expect(gasConfig).to.exist;
    expect(gasConfig.tokenExchangeRate).to.equal('347026904130352406214');
    expect(gasConfig.gasPrice).to.equal('201383436');
    const gasOverheadConfig =
      deployedDefaultHook.overhead[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2
      ];
    expect(gasOverheadConfig).to.exist;
    expect(gasOverheadConfig).to.equal(100);

    const deployedRequiredHook = coreConfig.requiredHook;
    assert(
      deployedRequiredHook.type === HookType.MERKLE_TREE,
      `Expected deployed requiredHook to be of type ${HookType.MERKLE_TREE}`,
    );

    const deployedDefaultIsm = coreConfig.defaultIsm;
    assert(
      deployedDefaultIsm.type === IsmType.ROUTING,
      `Expected deployed defaultIsm to be of type ${IsmType.ROUTING}`,
    );
    expect(deployedDefaultIsm.owner).to.equal(options.expectedDefaultIsmOwner);
    expect(objLength(deployedDefaultIsm.domains)).to.equal(2);

    const maybeRoutingIsm =
      deployedDefaultIsm.domains[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ];
    assert(
      typeof maybeRoutingIsm !== 'string' &&
        maybeRoutingIsm.type === IsmType.ROUTING,
      `Expected ism for ${TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1} to be of type ${IsmType.ROUTING}`,
    );

    const maybeTestIsm =
      maybeRoutingIsm.domains[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2];
    assert(
      typeof maybeTestIsm !== 'string' &&
        maybeTestIsm.type === IsmType.TEST_ISM,
      `Expected ism for ${TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2} to be of type ${IsmType.TEST_ISM}`,
    );

    const maybeMessageIdIsm =
      deployedDefaultIsm.domains[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2
      ];
    assert(
      typeof maybeMessageIdIsm !== 'string' &&
        maybeMessageIdIsm.type === IsmType.MESSAGE_ID_MULTISIG,
      `Expected ism for ${TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2} to be of type ${IsmType.MESSAGE_ID_MULTISIG}`,
    );

    expect(maybeMessageIdIsm.threshold).to.equal(1);
    expect(maybeMessageIdIsm.validators.length).to.equal(1);
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
          expectedMailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the mailbox',
        expect: {
          expectedDefaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedDefaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedMailboxOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the defaultHook',
        expect: {
          expectedDefaultHookOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
          expectedDefaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedMailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the defaultIsm',
        expect: {
          expectedDefaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          expectedDefaultIsmOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
          expectedMailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        },
      },
    ];

    for (const { description, expect } of testCases) {
      it(description, async () => {
        const coreConfig: CoreConfig = await readYamlOrJson(
          CORE_CONFIG_PATH_BY_PROTOCOL.radix,
        );

        coreConfig.owner = expect.expectedMailboxOwner;

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

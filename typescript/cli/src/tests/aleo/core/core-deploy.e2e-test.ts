import { expect } from 'chai';

import {
  type CoreConfig,
  type DerivedCoreConfig,
  HookType,
  IsmType,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  ProtocolType,
  assert,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

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

describe('hyperlane core deploy (Aleo E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Aleo,
    TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
  );

  type CoreConfigOwnershipAssertion = {
    expectedMailboxOwner: Address;
    expectedDefaultHookOwner: Address;
    expectedDefaultIsmOwner: Address;
  };

  // see typescript/cli/examples/aleo/core-config.yaml
  function assertTestAleoCoreConfig(
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
        TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1
      ];
    expect(gasConfig).to.exist;
    expect(gasConfig.tokenExchangeRate).to.equal('10000000000');
    expect(gasConfig.gasPrice).to.equal('1');

    const gasOverheadConfig =
      deployedDefaultHook.overhead[
        TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1
      ];
    expect(gasOverheadConfig).to.exist;
    expect(gasOverheadConfig).to.equal(200000);

    const deployedRequiredHook = coreConfig.requiredHook;
    assert(
      deployedRequiredHook.type === HookType.MERKLE_TREE,
      `Expected deployed requiredHook to be of type ${HookType.MERKLE_TREE}`,
    );

    const deployedDefaultIsm = coreConfig.defaultIsm;
    assert(
      deployedDefaultIsm.type === IsmType.MESSAGE_ID_MULTISIG,
      `Expected deployed defaultIsm to be of type ${IsmType.MESSAGE_ID_MULTISIG}`,
    );
    expect(deployedDefaultIsm.threshold).to.equal(1);
    expect(deployedDefaultIsm.validators.length).to.equal(1);
    expect(normalizeAddressEvm(deployedDefaultIsm.validators[0])).to.equal(
      normalizeAddressEvm('0x0c60e7eCd06429052223C78452F791AAb5C5CAc6'),
    );
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
          expectedDefaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
          expectedDefaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
          expectedMailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the mailbox',
        expect: {
          expectedDefaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
          expectedDefaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
          expectedMailboxOwner: BURN_ADDRESS_BY_PROTOCOL.aleo,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the defaultHook',
        expect: {
          expectedDefaultHookOwner: BURN_ADDRESS_BY_PROTOCOL.aleo,
          expectedDefaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
          expectedMailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the defaultIsm',
        expect: {
          expectedDefaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
          expectedDefaultIsmOwner: BURN_ADDRESS_BY_PROTOCOL.aleo,
          expectedMailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
        },
      },
    ];

    for (const { description, expect } of testCases) {
      it(description, async () => {
        const coreConfig: CoreConfig = await readYamlOrJson(
          CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
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
            defaultIsmConfig.type === IsmType.MESSAGE_ID_MULTISIG,
          `Expected defaultIsm in deploy config to be of type ${IsmType.MESSAGE_ID_MULTISIG}`,
        );

        coreConfig.defaultHook = defaultHookConfig;
        coreConfig.defaultIsm = defaultIsmConfig;

        writeYamlOrJson(
          CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
          coreConfig,
        );
        hyperlaneCore.setCoreInputPath(
          CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
        );

        await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.aleo);

        const derivedCoreConfig = await hyperlaneCore.readConfig();

        assertTestAleoCoreConfig(derivedCoreConfig, expect);
      });
    }
  });
});

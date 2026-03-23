import { type CoreConfig, HookType, IsmType } from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

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
import {
  expectStarknetCoreConfig,
  updateProtocolFeeCoreConfig,
} from '../helpers.js';

describe('hyperlane core deploy (Starknet E2E tests)', async function () {
  this.timeout(4 * DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  );

  type ExpectedOwners = {
    mailboxOwner: Address;
    defaultHookOwner: Address;
    defaultIsmOwner: Address;
  };

  const testCases: { description: string; expected: ExpectedOwners }[] = [
    {
      description:
        'should create a core deployment with the signer as the mailbox owner',
      expected: {
        mailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        defaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        defaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      },
    },
    {
      description:
        'should create a core deployment with the provided address as the owner of the mailbox',
      expected: {
        mailboxOwner: BURN_ADDRESS_BY_PROTOCOL.starknet,
        defaultHookOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        defaultIsmOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      },
    },
    {
      description:
        'should create a core deployment with the provided address as the owner of the defaultHook and defaultIsm',
      expected: {
        mailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        defaultHookOwner: BURN_ADDRESS_BY_PROTOCOL.starknet,
        defaultIsmOwner: BURN_ADDRESS_BY_PROTOCOL.starknet,
      },
    },
  ];

  for (const { description, expected } of testCases) {
    it(description, async () => {
      const coreConfig: CoreConfig = readYamlOrJson(
        CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
      );
      coreConfig.owner = expected.mailboxOwner;

      updateProtocolFeeCoreConfig(coreConfig, {
        beneficiary: expected.defaultHookOwner,
        owner: expected.defaultHookOwner,
      });

      assert(
        typeof coreConfig.defaultIsm !== 'string' &&
          coreConfig.defaultIsm.type === IsmType.ROUTING,
        'Expected defaultIsm to be routing',
      );
      coreConfig.defaultIsm = {
        ...coreConfig.defaultIsm,
        owner: expected.defaultIsmOwner,
      };

      assert(
        typeof coreConfig.requiredHook !== 'string' &&
          coreConfig.requiredHook.type === HookType.MERKLE_TREE,
        'Expected requiredHook to be merkleTreeHook',
      );

      writeYamlOrJson(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
        coreConfig,
      );
      hyperlaneCore.setCoreInputPath(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      );

      await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.starknet);

      const derivedCoreConfig = await hyperlaneCore.readConfig();
      expectStarknetCoreConfig(derivedCoreConfig, {
        ...expected,
        protocolFee: '10',
      });
    });
  }
});

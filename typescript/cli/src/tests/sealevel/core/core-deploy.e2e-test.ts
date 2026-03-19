import { expect } from 'chai';

import {
  type CoreConfig,
  type DerivedCoreConfig,
  HookType,
  IsmType,
} from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
} from '../../constants.js';

// SVM deploys programs from bytes (~90+ write-chunk transactions per program),
// so the suite needs a generous timeout.
const SVM_DEPLOY_TIMEOUT = 600_000;

describe('hyperlane core deploy (Sealevel E2E tests)', async function () {
  this.timeout(SVM_DEPLOY_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Sealevel,
    'svmlocal1',
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
  );

  type CoreConfigOwnershipAssertion = {
    expectedMailboxOwner: Address;
  };

  function assertTestSealevelCoreConfig(
    coreConfig: DerivedCoreConfig,
    options: CoreConfigOwnershipAssertion,
  ) {
    expect(coreConfig.owner).to.equal(options.expectedMailboxOwner);
    expect(coreConfig.proxyAdmin?.owner).to.be.undefined;

    const deployedDefaultHook = coreConfig.defaultHook;
    assert(
      deployedDefaultHook.type === HookType.MERKLE_TREE,
      `Expected deployed defaultHook to be of type ${HookType.MERKLE_TREE}`,
    );

    const deployedRequiredHook = coreConfig.requiredHook;
    assert(
      deployedRequiredHook.type === HookType.MERKLE_TREE,
      `Expected deployed requiredHook to be of type ${HookType.MERKLE_TREE}`,
    );

    const deployedDefaultIsm = coreConfig.defaultIsm;
    assert(
      deployedDefaultIsm.type === IsmType.TEST_ISM,
      `Expected deployed defaultIsm to be of type ${IsmType.TEST_ISM}`,
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
          expectedMailboxOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.sealevel,
        },
      },
      {
        description:
          'should create a core deployment with the provided address as the owner of the mailbox',
        expect: {
          expectedMailboxOwner: BURN_ADDRESS_BY_PROTOCOL.sealevel,
        },
      },
    ];

    for (const { description, expect } of testCases) {
      it(description, async () => {
        const coreConfig: CoreConfig = await readYamlOrJson(
          CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
        );

        coreConfig.owner = expect.expectedMailboxOwner;

        writeYamlOrJson(
          CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
          coreConfig,
        );
        hyperlaneCore.setCoreInputPath(
          CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
        );

        await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.sealevel);

        const derivedCoreConfig = await hyperlaneCore.readConfig();

        assertTestSealevelCoreConfig(derivedCoreConfig, expect);
      });
    }
  });
});

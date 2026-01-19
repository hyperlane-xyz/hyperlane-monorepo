import { expect } from 'chai';

import {
  type CoreConfig,
  HookType,
  type IgpConfig,
  IsmType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../../utils/files.js';
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

describe('hyperlane core read (Aleo E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Aleo,
    TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
  );

  it('should read a core deployment', async () => {
    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.aleo);

    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();

    expect(coreConfig.owner).to.equal(HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo);
    expect(coreConfig.proxyAdmin?.owner).to.be.undefined;
    expect(coreConfig.requiredHook).not.to.be.undefined;
    expect(coreConfig.defaultHook).not.to.be.undefined;
    expect(coreConfig.defaultIsm).not.to.be.undefined;

    const defaultHookConfig = coreConfig.defaultHook;
    assert(
      typeof defaultHookConfig !== 'string' &&
        defaultHookConfig.type === HookType.INTERCHAIN_GAS_PAYMASTER,
      `Expected deployed defaultHook to be of type ${HookType.INTERCHAIN_GAS_PAYMASTER}`,
    );
    expect(defaultHookConfig.owner).to.equal(
      HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
    );

    const defaultIsmConfig = coreConfig.defaultIsm;
    assert(
      typeof defaultIsmConfig !== 'string' &&
        defaultIsmConfig.type === IsmType.MESSAGE_ID_MULTISIG,
      `Expected deployed defaultIsm to be of type ${IsmType.MESSAGE_ID_MULTISIG}`,
    );
  });
});

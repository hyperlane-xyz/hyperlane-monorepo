import { expect } from 'chai';

import {
  type CoreConfig,
  type DerivedCoreConfig,
  HookType,
  IsmType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../../constants.js';

// SVM deploys programs from bytes (~90+ write-chunk transactions per program),
// so the suite needs a generous timeout.
const SVM_DEPLOY_TIMEOUT = 600_000;

// `core read` overwrites its output path with the on-chain config, so the
// original input is kept apart for `core check` to compare chain state against.
const CORE_INPUT_PATH = `${TEMP_PATH}/svmlocal1/core-routing-message-id-multisig-ism-input.yaml`;

describe('hyperlane core deploy/read/check with a routingMessageIdMultisigIsm defaultIsm (Sealevel E2E tests)', async function () {
  this.timeout(SVM_DEPLOY_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Sealevel,
    'svmlocal1',
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
  );

  before(async function () {
    const baseConfig: CoreConfig = readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
    );
    const coreConfig: CoreConfig = {
      ...baseConfig,
      // core read reports merkleTreeHook as the default hook on SVM, so any
      // other expected hook would make core check report a hook diff.
      defaultHook: { type: HookType.MERKLE_TREE },
      defaultIsm: {
        type: IsmType.ROUTING_MESSAGE_ID_MULTISIG,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.sealevel,
        domains: {
          anvil1: {
            validators: [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`],
            threshold: 2,
          },
          anvil2: { validators: [`0x${'3'.repeat(40)}`], threshold: 1 },
        },
      },
    };

    writeYamlOrJson(CORE_INPUT_PATH, coreConfig);
    hyperlaneCore.setCoreInputPath(CORE_INPUT_PATH);

    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.sealevel);
  });

  it('should deploy a routingMessageIdMultisigIsm as the default ISM and read it back', async () => {
    const derivedCoreConfig: DerivedCoreConfig =
      await hyperlaneCore.readConfig();

    expect(derivedCoreConfig.owner).to.equal(
      HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.sealevel,
    );

    const deployedDefaultIsm = derivedCoreConfig.defaultIsm;
    assert(
      deployedDefaultIsm.type === IsmType.ROUTING_MESSAGE_ID_MULTISIG,
      `Expected deployed defaultIsm to be of type ${IsmType.ROUTING_MESSAGE_ID_MULTISIG}`,
    );
    expect(deployedDefaultIsm.owner).to.equal(
      HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.sealevel,
    );
    expect(deployedDefaultIsm.domains).to.deep.equal({
      anvil1: {
        validators: [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`],
        threshold: 2,
      },
      anvil2: { validators: [`0x${'3'.repeat(40)}`], threshold: 1 },
    });
  });

  it('should report no diff via core check against the deployed ISM', async () => {
    hyperlaneCore.setCoreOutputPath(CORE_INPUT_PATH);
    const output = await hyperlaneCore.check(/* mailbox */ undefined).nothrow();
    expect(output.exitCode).to.equal(0);
  });
});

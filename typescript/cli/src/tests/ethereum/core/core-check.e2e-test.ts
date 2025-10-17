import { expect } from 'chai';
import { $ } from 'zx';

import { randomAddress } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';

describe('hyperlane core check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  before(async () => {
    await hyperlaneCore.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum);
  });

  it('should throw an error if the --chain param is not provided', async () => {
    const wrongCommand =
      $`yarn workspace @hyperlane-xyz/cli run hyperlane core check \
              --registry ${REGISTRY_PATH} \
              --config ${CORE_CONFIG_PATH_BY_PROTOCOL.ethereum} \
              --verbosity debug \
              --yes`.nothrow();

    const output = await wrongCommand;

    expect(output.exitCode).to.equal(1);
    expect(output.text().includes('Missing required argument: chain')).to.be
      .true;
  });

  it('should successfully run the core check command', async () => {
    await hyperlaneCore.readConfig();

    const output = await hyperlaneCore.check();

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.includes('No violations found');
  });

  it('should find differences between the local and onchain config', async () => {
    const coreConfig = await hyperlaneCore.readConfig();
    coreConfig.owner = randomAddress();
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      coreConfig,
    );
    const expectedDiffText = `EXPECTED: "${coreConfig.owner}"\n`;
    const expectedActualText = `ACTUAL: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"\n`;

    const output = await hyperlaneCore.check().nothrow();

    expect(output.exitCode).to.equal(1);
    expect(output.text()).to.include(expectedDiffText);
    expect(output.text()).to.include(expectedActualText);
  });

  it('should successfully check the config when provided with a custom mailbox', async () => {
    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.ethereum);
    const coreConfig = await hyperlaneCore.readConfig();
    expect(coreConfig.interchainAccountRouter?.mailbox).not.to.be.undefined;

    const output = await hyperlaneCore.check(
      coreConfig.interchainAccountRouter!.mailbox,
    );

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.includes('No violations found');
  });
});

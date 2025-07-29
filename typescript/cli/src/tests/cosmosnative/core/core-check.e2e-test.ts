import { expect } from 'chai';
import { $ } from 'zx';

import { randomCosmosAddress } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
} from '../consts.js';

describe('hyperlane cosmosnative core check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );

  before(async () => {
    await hyperlaneCore.deploy(HYP_KEY);
  });

  it('should throw an error if the --chain param is not provided', async () => {
    const wrongCommand =
      $`yarn workspace @hyperlane-xyz/cli run hyperlane core check \
              --registry ${REGISTRY_PATH} \
              --config ${CORE_CONFIG_PATH} \
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
    coreConfig.owner = await randomCosmosAddress('hyp');
    writeYamlOrJson(CORE_READ_CONFIG_PATH_1, coreConfig);
    const expectedDiffText = `EXPECTED: ${coreConfig.owner}\n`;
    const expectedActualText = `ACTUAL: hyp1jq304cthpx0lwhpqzrdjrcza559ukyy3sc4dw5\n`;

    const output = await hyperlaneCore.check().nothrow();

    expect(output.exitCode).to.equal(1);
    expect(output.text()).to.include(expectedDiffText);
    expect(output.text()).to.include(expectedActualText);
  });
});

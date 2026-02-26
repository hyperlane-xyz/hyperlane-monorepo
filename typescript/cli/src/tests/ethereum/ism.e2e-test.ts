import { expect } from 'chai';

import { normalizeConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType, deepEquals } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import { HyperlaneE2EIsmTestCommands } from '../commands/ism.js';

import { hyperlaneCoreDeploy } from './commands/core.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from './consts.js';

// First 3 anvil accounts as validators
const VALIDATORS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
];

describe('hyperlane ism e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let ismCommands: HyperlaneE2EIsmTestCommands;

  before(async function () {
    // Deploy core contracts to anvil2 (needed for ISM deployment)
    await hyperlaneCoreDeploy(CHAIN_NAME_2, './examples/core-config.yaml');

    ismCommands = new HyperlaneE2EIsmTestCommands(
      ProtocolType.Ethereum,
      CHAIN_NAME_2,
      REGISTRY_PATH,
    );
  });

  it('deploys a routing ISM with aggregation and multisig modules', async function () {
    // Tests: domainRoutingIsm, staticAggregationIsm, merkleRootMultisigIsm, messageIdMultisigIsm
    const config = {
      type: 'domainRoutingIsm',
      owner: ANVIL_DEPLOYER_ADDRESS,
      domains: {
        [CHAIN_NAME_3]: {
          type: 'staticAggregationIsm',
          threshold: 1,
          modules: [
            {
              type: 'merkleRootMultisigIsm',
              threshold: 2,
              validators: VALIDATORS,
            },
            {
              type: 'messageIdMultisigIsm',
              threshold: 2,
              validators: VALIDATORS,
            },
          ],
        },
      },
    };

    const configPath = `${TEMP_PATH}/test-ism-config.yaml`;
    const deployOutPath = `${TEMP_PATH}/deployed-ism.json`;
    const readOutPath = `${TEMP_PATH}/ism-read.yaml`;

    writeYamlOrJson(configPath, config);

    // Deploy ISM to anvil2
    const address = await ismCommands.deployAndGetAddress(
      ANVIL_KEY,
      configPath,
      deployOutPath,
    );
    expect(address).to.match(/^0x[a-fA-F0-9]{40}$/);

    // Read back the deployed ISM config
    const readConfig = await ismCommands.readConfig(address, readOutPath);

    // Compare configs using normalizeConfig (strips addresses, lowercases, sorts arrays)
    const normalizedOriginal = normalizeConfig(config);
    const normalizedRead = normalizeConfig(readConfig);

    expect(
      deepEquals(normalizedOriginal, normalizedRead),
      `Config mismatch:\nOriginal: ${JSON.stringify(normalizedOriginal, null, 2)}\nRead: ${JSON.stringify(normalizedRead, null, 2)}`,
    ).to.be.true;
  });
});

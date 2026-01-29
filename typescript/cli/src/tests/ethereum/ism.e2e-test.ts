import { expect } from 'chai';
import { $ } from 'zx';

import { normalizeConfig } from '@hyperlane-xyz/sdk';
import { deepEquals } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';

import { hyperlaneCoreDeploy } from './commands/core.js';
import { localTestRunCmdPrefix } from './commands/helpers.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
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

async function hyperlaneIsmDeploy(
  chain: string,
  configPath: string,
  outPath: string,
): Promise<string> {
  await $`${localTestRunCmdPrefix()} hyperlane ism deploy \
    --registry ${REGISTRY_PATH} \
    --chain ${chain} \
    --config ${configPath} \
    --out ${outPath} \
    --key ${ANVIL_KEY} \
    --verbosity debug \
    --yes`;

  const output = readYamlOrJson<{ address: string }>(outPath);
  return output.address;
}

async function hyperlaneIsmRead(
  chain: string,
  address: string,
  outPath: string,
): Promise<any> {
  await $`${localTestRunCmdPrefix()} hyperlane ism read \
    --registry ${REGISTRY_PATH} \
    --chain ${chain} \
    --address ${address} \
    --out ${outPath}`;

  return readYamlOrJson(outPath);
}

describe('hyperlane ism e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  before(async function () {
    // Deploy core contracts to anvil2 (needed for ISM deployment)
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
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
    const address = await hyperlaneIsmDeploy(
      CHAIN_NAME_2,
      configPath,
      deployOutPath,
    );
    expect(address).to.match(/^0x[a-fA-F0-9]{40}$/);

    // Read back the deployed ISM config
    const readConfig = await hyperlaneIsmRead(
      CHAIN_NAME_2,
      address,
      readOutPath,
    );

    // Compare configs using normalizeConfig (strips addresses, lowercases, sorts arrays)
    const normalizedOriginal = normalizeConfig(config);
    const normalizedRead = normalizeConfig(readConfig);

    expect(
      deepEquals(normalizedOriginal, normalizedRead),
      `Config mismatch:\nOriginal: ${JSON.stringify(normalizedOriginal, null, 2)}\nRead: ${JSON.stringify(normalizedRead, null, 2)}`,
    ).to.be.true;
  });
});

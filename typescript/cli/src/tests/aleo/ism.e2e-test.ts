import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../commands/core.js';
import { HyperlaneE2EIsmTestCommands } from '../commands/ism.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';

import './e2e-test.setup.js';

const { CHAIN_NAME_1, CHAIN_NAME_2 } =
  TEST_CHAIN_NAMES_BY_PROTOCOL[ProtocolType.Aleo];
const HYP_KEY = HYP_KEY_BY_PROTOCOL[ProtocolType.Aleo];
const DEPLOYER_ADDRESS = HYP_DEPLOYER_ADDRESS_BY_PROTOCOL[ProtocolType.Aleo];
const CORE_CONFIG_PATH = CORE_CONFIG_PATH_BY_PROTOCOL[ProtocolType.Aleo];
// Use same validator address as Ethereum tests for consistency
const VALIDATOR_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const DEFAULT_E2E_TEST_TIMEOUT = 100_000;

describe('hyperlane ism e2e tests (aleo)', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let ismCommands: HyperlaneE2EIsmTestCommands;

  before(async function () {
    // Deploy core contracts first (required for ISM deployment)
    const coreCommands = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Aleo,
      CHAIN_NAME_1,
      REGISTRY_PATH,
      CORE_CONFIG_PATH,
      `${TEMP_PATH}/${CHAIN_NAME_1}/core-config-read.yaml`,
    );
    await coreCommands.deploy(HYP_KEY);

    ismCommands = new HyperlaneE2EIsmTestCommands(
      ProtocolType.Aleo,
      CHAIN_NAME_1,
      REGISTRY_PATH,
    );
  });

  it('deploys a routing ISM with messageIdMultisig module', async function () {
    // Uses routing -> messageIdMultisig (no aggregation, unsupported on altVMs)
    const config = {
      type: 'domainRoutingIsm',
      owner: DEPLOYER_ADDRESS,
      domains: {
        [CHAIN_NAME_2]: {
          type: 'messageIdMultisigIsm',
          threshold: 1,
          validators: [VALIDATOR_ADDRESS],
        },
      },
    };

    const configPath = `${TEMP_PATH}/test-ism-config-aleo.yaml`;
    const deployOutPath = `${TEMP_PATH}/deployed-ism-aleo.json`;

    writeYamlOrJson(configPath, config);

    // Deploy ISM and verify address is returned
    const address = await ismCommands.deployAndGetAddress(
      HYP_KEY,
      configPath,
      deployOutPath,
    );
    expect(address).to.be.a('string').and.not.be.empty;

    // Note: ism read is not yet supported for Aleo, so we only verify deploy
  });
});

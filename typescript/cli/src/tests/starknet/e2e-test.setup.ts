import fs from 'fs';
import { type StartedTestContainer } from 'testcontainers';

import { TEST_STARKNET_ACCOUNT_ADDRESS } from '@hyperlane-xyz/starknet-sdk';

import {
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';
import { runStarknetNode } from '../nodes.js';

const SETUP_TIMEOUT_MS = 2 * DEFAULT_E2E_TEST_TIMEOUT;

let starknetNode1: StartedTestContainer | undefined;
let starknetNode2: StartedTestContainer | undefined;
let previousAccountAddress: string | undefined;

before(async function () {
  this.timeout(SETUP_TIMEOUT_MS);

  Object.entries(TEST_CHAIN_NAMES_BY_PROTOCOL).forEach(
    ([_protocol, chainNames]) => {
      Object.entries(chainNames).forEach(([_key, name]) => {
        const path = `${REGISTRY_PATH}/chains/${name}/addresses.yaml`;
        if (fs.existsSync(path)) {
          fs.rmSync(path, { recursive: true, force: true });
        }
      });
    },
  );

  previousAccountAddress = process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
  process.env.HYP_ACCOUNT_ADDRESS_STARKNET = TEST_STARKNET_ACCOUNT_ADDRESS;

  [starknetNode1, starknetNode2] = await Promise.all([
    runStarknetNode(TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1),
    runStarknetNode(TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_2),
  ]);
});

beforeEach(() => {
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;
  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});

after(async function () {
  this.timeout(SETUP_TIMEOUT_MS);

  await Promise.all(
    [starknetNode1?.stop(), starknetNode2?.stop()].filter(Boolean),
  );

  if (previousAccountAddress === undefined) {
    delete process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
  } else {
    process.env.HYP_ACCOUNT_ADDRESS_STARKNET = previousAccountAddress;
  }
});

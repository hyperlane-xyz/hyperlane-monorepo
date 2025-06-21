import { JsonRpcProvider } from '@ethersproject/providers';
import fs from 'fs';

import { CORE_PROTOCOL_ANVIL_STATE, ChainMetadata } from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  E2E_TEST_WARP_ROUTE_REGISTRY_PATH,
  REGISTRY_PATH,
} from './commands/helpers.js';

const chainsToPreConfigure = [
  {
    name: CHAIN_NAME_2,
    metadataPath: CHAIN_2_METADATA_PATH,
  },
  {
    name: CHAIN_NAME_3,
    metadataPath: CHAIN_3_METADATA_PATH,
  },
];

const allowedTests = new Set([
  'warp-deploy',
  'warp-apply',
  'warp-read',
  'warp-check',
  'warp-extend-recovery',
]);

function writeChainAddressesToRegistry(chainName: string) {
  writeYamlOrJson(
    `${REGISTRY_PATH}/chains/${chainName}/addresses.yaml`,
    CORE_PROTOCOL_ANVIL_STATE.addresses,
  );
}

const canLoadCoreDeploymentData = (currentTestFile = '') =>
  allowedTests.has(process.env.CLI_E2E_TEST ?? currentTestFile);

before(async function () {
  await Promise.all(
    chainsToPreConfigure.map(async (config) => {
      try {
        const chainMeta: ChainMetadata = readYamlOrJson(config.metadataPath);

        const provider = new JsonRpcProvider(chainMeta.rpcUrls[0].http);

        writeChainAddressesToRegistry(chainMeta.name);

        await provider.send('anvil_loadState', [
          // @ts-ignore
          CORE_PROTOCOL_ANVIL_STATE.chains[config.name],
        ]);
      } catch (error) {
        console.error(
          `Error loading core deployment data for ${config.name}: ${error}`,
          error,
        );
      }
    }),
  );
});

// Reset the test registry for each test invocation
beforeEach(function () {
  if (fs.existsSync(E2E_TEST_WARP_ROUTE_REGISTRY_PATH)) {
    fs.rmSync(E2E_TEST_WARP_ROUTE_REGISTRY_PATH, {
      recursive: true,
      force: true,
    });
  }

  // Get the current file name and extract the corresponding primary name:
  // Example: warp-read.e2e-test.ts -> warp-read
  const currentTestFileName = this.test?.ctx?.currentTest?.file?.split('.')[0];
  if (!canLoadCoreDeploymentData(currentTestFileName)) {
    return;
  }

  chainsToPreConfigure.forEach((config) =>
    writeChainAddressesToRegistry(config.name),
  );
});

import fs from 'fs';

import { ProtocolType, deepCopy } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_METADATA_PATH_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';
import { runRadixNode } from '../nodes.js';

const HYPERLANE_RADIX_GIT = 'https://github.com/hyperlane-xyz/hyperlane-radix';
const HYPERLANE_RADIX_VERSION = '1.1.0';

let orginalRadixTestMentadata:
  | typeof TEST_CHAIN_METADATA_BY_PROTOCOL.radix
  | undefined;

async function downloadFile(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function downloadRadixContracts(): Promise<{
  code: Uint8Array;
  packageDefinition: Uint8Array;
}> {
  console.log(`Downloading hyperlane-radix v${HYPERLANE_RADIX_VERSION}...`);

  const wasmUrl = `${HYPERLANE_RADIX_GIT}/releases/download/v${HYPERLANE_RADIX_VERSION}/hyperlane_radix.wasm`;
  const rpdUrl = `${HYPERLANE_RADIX_GIT}/releases/download/v${HYPERLANE_RADIX_VERSION}/hyperlane_radix.rpd`;

  const [code, packageDefinition] = await Promise.all([
    downloadFile(wasmUrl),
    downloadFile(rpdUrl),
  ]);

  console.log('Downloaded Radix contracts successfully');
  return { code, packageDefinition };
}

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  // Clean up existing chain addresses
  Object.entries(TEST_CHAIN_NAMES_BY_PROTOCOL).forEach(
    ([_protocol, chainNames]) => {
      Object.entries(chainNames).map(([_key, name]) => {
        const path = `${REGISTRY_PATH}/chains/${name}/addresses.yaml`;

        if (fs.existsSync(path)) {
          fs.rmSync(path, { recursive: true, force: true });
        }
      });
    },
  );

  // Download Radix contracts
  const { code, packageDefinition } = await downloadRadixContracts();

  // Store the original metadata so that it can be restored after all the test run
  orginalRadixTestMentadata = deepCopy(TEST_CHAIN_METADATA_BY_PROTOCOL.radix);

  // Run only one node for now
  await runRadixNode(TEST_CHAIN_METADATA_BY_PROTOCOL.radix.CHAIN_NAME_1, {
    code: new Uint8Array(code),
    packageDefinition: new Uint8Array(packageDefinition),
  });

  // Write back to registry file so CLI can read the package address field injected
  // when starting the node
  const metadataPath = TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1;
  const updatedMetadata = TEST_CHAIN_METADATA_BY_PROTOCOL.radix.CHAIN_NAME_1;
  writeYamlOrJson(metadataPath, updatedMetadata);
});

// Reset the test registry for each test invocation
beforeEach(() => {
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});

after(function () {
  // Restore the original test metadata
  for (const [chainName, originalMetadata] of Object.entries(
    orginalRadixTestMentadata ?? {},
  )) {
    const metadataPath =
      TEST_CHAIN_METADATA_PATH_BY_PROTOCOL[ProtocolType.Radix][
        chainName as keyof typeof TEST_CHAIN_METADATA_BY_PROTOCOL.radix
      ];

    writeYamlOrJson(metadataPath, originalMetadata);
  }
});

import fs from 'fs';

import {
  deployHyperlaneRadixPackage,
  downloadRadixContracts,
  runRadixNode,
} from '@hyperlane-xyz/radix-sdk/testing';
import { ProtocolType, deepCopy } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_METADATA_PATH_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';

let orginalRadixTestMentadata:
  | typeof TEST_CHAIN_METADATA_BY_PROTOCOL.radix
  | undefined;

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

  const t = Object.keys(
    TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix,
  ) as (keyof typeof TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix)[];

  for (const chain of t) {
    const hyperlanePackageAddress = await deployHyperlaneRadixPackage(
      TEST_CHAIN_METADATA_BY_PROTOCOL.radix[chain],
      {
        code: new Uint8Array(code),
        packageDefinition: new Uint8Array(packageDefinition),
      },
    );

    // Write back to registry file so CLI can read the package address field injected
    // when starting the node
    const metadataPath = TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix[chain];
    const updatedMetadata = TEST_CHAIN_METADATA_BY_PROTOCOL.radix[chain];

    updatedMetadata.packageAddress = hyperlanePackageAddress;
    writeYamlOrJson(metadataPath, updatedMetadata);
  }
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

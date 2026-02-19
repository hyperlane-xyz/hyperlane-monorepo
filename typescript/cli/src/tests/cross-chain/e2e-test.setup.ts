import fs from 'fs';
import { type StartedDockerComposeEnvironment } from 'testcontainers';

import {
  deployHyperlaneRadixPackage,
  downloadRadixContracts,
  runRadixNode,
} from '@hyperlane-xyz/radix-sdk/testing';
import { ProtocolType, deepCopy } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  CROSS_CHAIN_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_METADATA_PATH_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';

// Store original Radix metadata before mutating with deployed package addresses.
// This allows us to restore the metadata files after tests complete, ensuring
// subsequent test runs don't inherit stale package addresses from a stopped node.
let originalRadixTestMetadata:
  | typeof TEST_CHAIN_METADATA_BY_PROTOCOL.radix
  | undefined;

// Store the Radix node instance to tear it down in the after hook
let radixNodeInstance: StartedDockerComposeEnvironment;

function isRadixPackageDeployment(
  value: unknown,
): value is { packageAddress: string; xrdAddress: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    'packageAddress' in value &&
    'xrdAddress' in value
  );
}

before(async function () {
  this.timeout(CROSS_CHAIN_E2E_TEST_TIMEOUT);

  // Clean up any existing chain address files from previous test runs
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

  const { code, packageDefinition } = await downloadRadixContracts();

  // Deep copy before mutating - the metadata object is shared across test files
  originalRadixTestMetadata = deepCopy(TEST_CHAIN_METADATA_BY_PROTOCOL.radix);

  radixNodeInstance = await runRadixNode(
    TEST_CHAIN_METADATA_BY_PROTOCOL.radix.CHAIN_NAME_1,
    {
      code: new Uint8Array(code),
      packageDefinition: new Uint8Array(packageDefinition),
    },
  );

  // Deploy Hyperlane packages and update metadata with the deployed addresses.
  // This mutates TEST_CHAIN_METADATA_BY_PROTOCOL and writes to metadata YAML files.
  const chainKeys = Object.keys(
    TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix,
  ) as (keyof typeof TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix)[];

  for (const chain of chainKeys) {
    const deployedPackage = (await deployHyperlaneRadixPackage(
      TEST_CHAIN_METADATA_BY_PROTOCOL.radix[chain],
      {
        code: new Uint8Array(code),
        packageDefinition: new Uint8Array(packageDefinition),
      },
    )) as unknown;
    const packageAddress = isRadixPackageDeployment(deployedPackage)
      ? deployedPackage.packageAddress
      : String(deployedPackage);
    const xrdAddress = isRadixPackageDeployment(deployedPackage)
      ? deployedPackage.xrdAddress
      : undefined;

    const metadataPath = TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix[chain];
    const updatedMetadata = TEST_CHAIN_METADATA_BY_PROTOCOL.radix[chain];

    updatedMetadata.packageAddress = packageAddress;

    // Update the native token denom with the actual XRD resource address for this network.
    // This is critical because the XRD address is derived from the network ID and must match
    // the token used in the faucet for funding accounts and the IGP for gas payments.
    if (updatedMetadata.nativeToken && xrdAddress) {
      updatedMetadata.nativeToken.denom = xrdAddress;
    }

    writeYamlOrJson(metadataPath, updatedMetadata);
  }
});

// Reset the test registry for each test invocation
beforeEach(() => {
  if (process.env.HYP_CROSSCHAIN_SKIP_WARP_CLEANUP === 'true') {
    return;
  }

  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});

// Restore original Radix metadata files and tear down the Radix node after tests.
// This prevents subsequent test runs from using stale package addresses
// that point to a Radix node that's no longer running.
after(async function () {
  this.timeout(CROSS_CHAIN_E2E_TEST_TIMEOUT);

  for (const [chainName, originalMetadata] of Object.entries(
    originalRadixTestMetadata ?? {},
  )) {
    const metadataPath =
      TEST_CHAIN_METADATA_PATH_BY_PROTOCOL[ProtocolType.Radix][
        chainName as keyof typeof TEST_CHAIN_METADATA_BY_PROTOCOL.radix
      ];

    writeYamlOrJson(metadataPath, originalMetadata);
  }

  if (radixNodeInstance) {
    await radixNodeInstance.down();
  }
});

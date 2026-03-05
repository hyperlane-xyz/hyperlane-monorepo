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
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_METADATA_PATH_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';

// Store the Radix node instance to tear it down in the after hook
let radixNodeInstance: StartedDockerComposeEnvironment;

let orginalRadixTestMentadata:
  | typeof TEST_CHAIN_METADATA_BY_PROTOCOL.radix
  | undefined;

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
  // Use 3x timeout for setup since Docker container startup can be slow in CI
  // (image pulling, postgres init, fullnode sync, gateway sync)
  this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

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
  radixNodeInstance = await runRadixNode(
    TEST_CHAIN_METADATA_BY_PROTOCOL.radix.CHAIN_NAME_1,
    {
      code: new Uint8Array(code),
      packageDefinition: new Uint8Array(packageDefinition),
    },
  );

  const t = Object.keys(
    TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix,
  ) as (keyof typeof TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.radix)[];

  for (const chain of t) {
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

    // Write back to registry file so CLI can read the package address field injected
    // when starting the node
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
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});

// Restore original Radix metadata files and tear down the Radix node after tests.
// This prevents subsequent test runs from using stale package addresses
// that point to a Radix node that's no longer running.
after(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

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

  if (radixNodeInstance) {
    await radixNodeInstance.down();
  }
});

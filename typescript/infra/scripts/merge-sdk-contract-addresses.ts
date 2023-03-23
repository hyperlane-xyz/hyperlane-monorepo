// Example use as script:
// yarn ts-node scripts/merge-sdk-contract-addresses.ts -e mainnet
import path from 'path';

import { ChainName, HyperlaneAddresses } from '@hyperlane-xyz/sdk';

import type { DeployEnvironment } from '../src/config';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { readJSON, writeJSON } from '../src/utils/utils';

import {
  getContractAddressesSdkFilepath,
  getEnvironment,
  getEnvironmentDirectory,
} from './utils';

const ARTIFACTS_TO_MERGE = [
  { pathSegment: 'middleware/accounts', targetKey: 'interchainAccountRouter' },
  { pathSegment: 'middleware/queries', targetKey: 'interchainQueryRouter' },
  { pathSegment: 'create2', targetKey: 'create2Factory' },
];

/**
 * Pulls addresses from the list of places in ARTIFACTS_TO_MERGE and adds
 * those addresses to the core address consts in the SDK
 */
export function mergeWithSdkContractAddressArtifacts(
  environment: DeployEnvironment,
) {
  const sdkEnvironment = deployEnvToSdkEnv[environment];
  const coreAddresses: HyperlaneAddresses = readJSON(
    getContractAddressesSdkFilepath(),
    `${sdkEnvironment}.json`,
  );

  for (const artifactSet of ARTIFACTS_TO_MERGE) {
    const artifactDir = path.join(
      getEnvironmentDirectory(environment),
      artifactSet.pathSegment,
    );
    const addresses: Record<ChainName, Record<string, string>> = readJSON(
      artifactDir,
      'addresses.json',
    );
    // Merge value into core addresses map
    for (const chain of Object.keys(addresses) as ChainName[]) {
      const chainValue = addresses[chain];
      const addressToMerge = Object.values(chainValue)[0];
      const coreChainValue = coreAddresses[chain];
      if (!coreChainValue || typeof coreChainValue !== 'object')
        throw new Error(`No core chain config for ${chain}`);
      // @ts-ignore
      coreChainValue[artifactSet.targetKey] = addressToMerge;
    }
  }

  writeJSON(
    getContractAddressesSdkFilepath(),
    `${sdkEnvironment}.json`,
    coreAddresses,
  );
}

async function main() {
  // If this is the entry point (i.e. someone ran ts-node ./this_file)
  if (require.main === module) {
    const environment = await getEnvironment();
    mergeWithSdkContractAddressArtifacts(environment);
  }
}

main()
  .then(() => console.info('Merge artifacts complete'))
  .catch(console.error);

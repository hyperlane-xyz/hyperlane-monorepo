import {
  ChainName,
  HyperlaneDeployer,
  buildContracts,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import {
  readJSONAtPath,
  writeJsonAtPath,
  writeMergedJSONAtPath,
} from './utils/utils';

export async function deployWithArtifacts(
  deployer: HyperlaneDeployer<any, any, any>,
  cache?: {
    addresses: string;
    verification: string;
  },
  fork?: ChainName,
) {
  if (cache) {
    let addresses = {};
    try {
      addresses = readJSONAtPath(cache.addresses);
    } catch (e) {
      console.error('Failed to load cached addresses');
    }

    const savedContracts = buildContracts(addresses, deployer.factories);
    deployer.cacheContracts(savedContracts);
  }

  try {
    if (fork) {
      await deployer.deployContracts(fork, deployer.configMap[fork]);
    } else {
      await deployer.deploy();
    }
  } catch (e) {
    console.error('Failed to deploy contracts', e);
  }

  if (cache) {
    // cache addresses of deployed contracts
    writeMergedJSONAtPath(
      cache.addresses,
      serializeContracts(deployer.deployedContracts),
    );

    let savedVerification = {};
    try {
      savedVerification = readJSONAtPath(cache.verification);
    } catch (e) {
      console.error('Failed to load cached verification inputs');
    }

    // cache verification inputs
    const inputs =
      deployer.mergeWithExistingVerificationInputs(savedVerification);
    writeJsonAtPath(cache.verification, inputs);
  }
}

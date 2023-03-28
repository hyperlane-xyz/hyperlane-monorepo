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
    const addresses = readJSONAtPath(cache.addresses);
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
    console.error(e);
  }

  if (cache) {
    writeMergedJSONAtPath(
      cache.addresses,
      serializeContracts(deployer.deployedContracts),
    );

    const savedVerification = readJSONAtPath(cache.verification);
    const inputs =
      deployer.mergeWithExistingVerificationInputs(savedVerification);
    writeJsonAtPath(cache.verification, inputs);
  }
}

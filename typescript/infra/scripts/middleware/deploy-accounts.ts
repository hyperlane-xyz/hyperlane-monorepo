import path from 'path';

import {
  HyperlaneCore,
  InterchainAccountDeployer,
  interchainAccountFactories,
} from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../../src/config/environment';
import { deployWithArtifacts } from '../../src/deploy';
import { getConfiguration } from '../helloworld/utils';
import { mergeWithSdkContractAddressArtifacts } from '../merge-sdk-contract-addresses';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

// similar to hello world deploy script but uses freshly funded account for consistent addresses across chains
// should eventually be deduped
async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'middleware/accounts',
  );

  // config gcp deployer key as owner
  const configMap = await getConfiguration(environment, multiProvider);

  const deployer = new InterchainAccountDeployer(
    multiProvider,
    configMap,
    core,
    'icav3',
  );

  await deployWithArtifacts(dir, interchainAccountFactories, deployer);
  mergeWithSdkContractAddressArtifacts(environment);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

import path from 'path';

import {
  InterchainQueryDeployer,
  interchainQueryFactories,
} from '@hyperlane-xyz/sdk';

import { deployWithArtifacts } from '../../src/deploy';
import { getConfiguration } from '../helloworld/utils';
import { mergeWithSdkContractAddressArtifacts } from '../merge-sdk-contract-addresses';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'middleware/queries',
  );

  // config gcp deployer key as owner
  const configMap = await getConfiguration(environment, multiProvider);

  const deployer = new InterchainQueryDeployer(
    multiProvider,
    configMap,
    'IQS-SALT-5',
  );

  await deployWithArtifacts(dir, interchainQueryFactories, deployer);
  mergeWithSdkContractAddressArtifacts(environment);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

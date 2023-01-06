import path from 'path';

import {
  HyperlaneCore,
  InterchainQueryDeployer,
  interchainQueryFactories,
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

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider as any,
  );

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'middleware/queries',
  );

  // config gcp deployer key as owner
  const configMap = await getConfiguration(environment, multiProvider);
  delete configMap['celo'];

  const deployer = new InterchainQueryDeployer(
    multiProvider,
    configMap,
    core,
    'IQS-SALT-4',
  );

  await deployWithArtifacts(dir, interchainQueryFactories, deployer);
  mergeWithSdkContractAddressArtifacts(environment);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

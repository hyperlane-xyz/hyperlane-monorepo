import path from 'path';

import {
  HyperlaneCore,
  InterchainQueryDeployer,
  interchainQueryFactories,
} from '@hyperlane-xyz/sdk';

import { deployWithArtifacts } from '../../src/deploy';
import { getConfiguration } from '../helloworld/utils';
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
  const core = HyperlaneCore.fromEnvironment(environment, multiProvider as any);

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'interchain/queries',
  );

  // config gcp deployer key as owner
  const configMap = await getConfiguration(environment, multiProvider);

  const deployer = new InterchainQueryDeployer(
    multiProvider,
    configMap,
    core,
    'IQS-SALT-3',
  );

  await deployWithArtifacts(dir, interchainQueryFactories, deployer);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

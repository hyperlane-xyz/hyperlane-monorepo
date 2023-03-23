import path from 'path';

import { HyperlaneIgp, objMap } from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../../src/config/environment';
import { deployWithArtifacts } from '../../src/deploy';
import {
  TestQuerySenderDeployer,
  factories,
} from '../../src/testcontracts/testquerysender';
import { readJSON } from '../../src/utils/utils';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const igp = HyperlaneIgp.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  // Get query router addresses
  const queryRouterDir = path.join(
    getEnvironmentDirectory(environment),
    'middleware/queries',
  );
  const queryRouterAddresses = objMap(
    readJSON(queryRouterDir, 'addresses.json'),
    (_c, conf) => ({ queryRouterAddress: conf.router }),
  );

  const deployer = new TestQuerySenderDeployer(
    multiProvider,
    queryRouterAddresses,
    igp,
  );

  const dir = path.join(
    getEnvironmentDirectory(environment),
    'testquerysender',
  );

  await deployWithArtifacts(dir, factories, deployer);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

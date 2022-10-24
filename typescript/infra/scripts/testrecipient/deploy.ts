import path from 'path';

import { deployWithArtifacts } from '../../src/deploy';
import { TestRecipientDeployer, factories } from '../../src/testrecipient';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();

  const deployer = new TestRecipientDeployer(multiProvider);
  const dir = path.join(getEnvironmentDirectory(environment), 'testrecipient');

  await deployWithArtifacts(dir, factories, deployer);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

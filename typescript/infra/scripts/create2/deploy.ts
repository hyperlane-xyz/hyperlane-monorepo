import path from 'path';

import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { Create2FactoryDeployer, factories } from '../../src/create2';
import { deployWithArtifacts } from '../../src/deploy';
import { mergeWithSdkContractAddressArtifacts } from '../merge-sdk-contract-addresses';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider(
    Contexts.Abacus,
    KEY_ROLE_ENUM.Create2Deployer,
  );

  const deployer = new Create2FactoryDeployer(multiProvider);
  const dir = path.join(getEnvironmentDirectory(environment), 'create2');

  await deployWithArtifacts(dir, factories, deployer);
  await mergeWithSdkContractAddressArtifacts(environment);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

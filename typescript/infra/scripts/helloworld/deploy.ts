import path from 'path';

import { HelloWorldDeployer } from '@abacus-network/helloworld';
import { AbacusCore, serializeContracts } from '@abacus-network/sdk';

import { writeJSON } from '../../src/utils/utils';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

import { getConfiguration } from './utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const configMap = await getConfiguration(environment, multiProvider);
  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);
  const deployer = new HelloWorldDeployer(multiProvider, configMap, core);
  try {
    const contracts = await deployer.deploy();
    const dir = path.join(getEnvironmentDirectory(environment), 'helloworld');
    writeJSON(dir, 'addresses.json', serializeContracts(contracts));
  } catch (error) {
    // @ts-ignore
    writeJSON(
      './',
      'partial.json',
      serializeContracts(deployer.deployedContracts!),
    );
  }
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

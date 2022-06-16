import path from 'path';

import { HelloWorldDeployer } from '@abacus-network/helloworld';
import { helloWorldFactories } from '@abacus-network/helloworld/dist/sdk/contracts';
import {
  AbacusCore,
  buildContracts,
  serializeContracts,
} from '@abacus-network/sdk';

import { readJSON, writeJSON } from '../../src/utils/utils';
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
  const dir = path.join(getEnvironmentDirectory(environment), 'helloworld');

  const addresses = readJSON(dir, 'partial_addresses.json');
  const partialContracts = buildContracts(addresses, helloWorldFactories);

  // @ts-ignore because partial is not plumbed through by helloworld deployer
  deployer.deployedContracts = partialContracts;

  try {
    const contracts = await deployer.deploy();
    writeJSON(dir, 'addresses.json', serializeContracts(contracts));
  } catch (e) {
    console.error(e);
    writeJSON(
      dir,
      'partial_addresses.json',
      serializeContracts(deployer.deployedContracts as any),
    );
  }
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

import path from 'path';

import {
  HelloWorldContracts,
  HelloWorldDeployer,
  helloWorldFactories,
} from '@abacus-network/helloworld';
import {
  AbacusCore,
  ChainMap,
  buildContracts,
  serializeContracts,
} from '@abacus-network/sdk';

import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { readJSON, writeJSON } from '../../src/utils/utils';
import {
  getContext,
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

import { getConfiguration } from './utils';

async function main() {
  const environment = await getEnvironment();
  const context = await getContext();
  const coreConfig = getCoreEnvironmentConfig(environment);
  // Always deploy from the abacus deployer
  const multiProvider = await coreConfig.getMultiProvider(
    Contexts.Abacus,
    KEY_ROLE_ENUM.Deployer,
  );
  const configMap = await getConfiguration(environment, multiProvider);
  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);
  const deployer = new HelloWorldDeployer(multiProvider, configMap, core);
  const dir = path.join(
    getEnvironmentDirectory(environment),
    'helloworld',
    context,
  );

  let previousContracts: ChainMap<any, HelloWorldContracts> = {};
  let existingVerificationInputs = {};
  try {
    const addresses = readJSON(dir, 'addresses.json');
    previousContracts = buildContracts(addresses, helloWorldFactories) as any;
    existingVerificationInputs = readJSON(dir, 'verification.json');
  } catch (e) {
    console.info(`Could not load previous deployment, file may not exist`);
  }

  try {
    await deployer.deploy(previousContracts);
  } catch (e) {
    console.error(`Encountered error during deploy`);
    console.error(e);
  }

  writeJSON(
    dir,
    'addresses.json',
    // @ts-ignore
    serializeContracts(deployer.deployedContracts),
  );
  writeJSON(
    dir,
    'verification.json',
    deployer.mergeWithExistingVerificationInputs(existingVerificationInputs),
  );
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

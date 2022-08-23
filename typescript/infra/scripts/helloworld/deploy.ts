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

  let partialContracts: ChainMap<any, HelloWorldContracts>;
  try {
    const addresses = readJSON(dir, 'partial_addresses.json');
    partialContracts = buildContracts(addresses, helloWorldFactories) as any;
  } catch (e) {
    partialContracts = {};
  }

  try {
    const contracts = await deployer.deploy(partialContracts);
    writeJSON(dir, 'addresses.json', serializeContracts(contracts));
    writeJSON(
      dir,
      'verification.json',
      JSON.stringify(deployer.verificationInputs),
    );
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

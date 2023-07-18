import path from 'path';

import { HelloWorldDeployer } from '@hyperlane-xyz/helloworld';
import { serializeContractsMap } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { Role } from '../../src/roles';
import { readJSON, writeJSON } from '../../src/utils/utils';
import {
  getArgs,
  getEnvironmentConfig,
  getEnvironmentDirectory,
  getRouterConfig,
  withContext,
} from '../utils';

async function main() {
  const { environment, context } = await withContext(getArgs()).argv;
  const coreConfig = getEnvironmentConfig(environment);
  // Always deploy from the hyperlane deployer
  const multiProvider = await coreConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
  );
  const configMap = await getRouterConfig(environment, multiProvider, true);
  const deployer = new HelloWorldDeployer(multiProvider);
  const dir = path.join(
    getEnvironmentDirectory(environment),
    'helloworld',
    context,
  );

  let existingVerificationInputs = {};
  try {
    const addresses = readJSON(dir, 'addresses.json');
    deployer.cacheAddressesMap(addresses);
    existingVerificationInputs = readJSON(dir, 'verification.json');
  } catch (e) {
    console.info(`Could not load previous deployment, file may not exist`);
  }

  try {
    await deployer.deploy(configMap);
  } catch (e) {
    console.error(`Encountered error during deploy`);
    console.error(e);
  }

  writeJSON(
    dir,
    'addresses.json',
    serializeContractsMap(deployer.deployedContracts),
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

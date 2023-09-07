import path from 'path';

import { HelloWorldDeployer } from '@hyperlane-xyz/helloworld';
import { serializeContractsMap } from '@hyperlane-xyz/sdk';
import { filterAddressesExcludeProtocol } from '@hyperlane-xyz/sdk/src';
import { ProtocolType, objMap, objMerge } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { Role } from '../../src/roles';
import { readJSON, writeJSON } from '../../src/utils/utils';
import {
  getEnvironmentConfig,
  getEnvironmentDirectory,
  getArgs as getRootArgs,
  getRouterConfig,
  withContext,
} from '../utils';

function getArgs() {
  return withContext(getRootArgs())
    .boolean('govern')
    .default('govern', false)
    .alias('g', 'govern').argv;
}

async function main() {
  const { environment, context } = await getArgs();
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

  const configMapWithForeignDeployments = objMerge(
    configMap,
    objMap(
      filterAddressesExcludeProtocol(
        deployer.cachedAddresses,
        ProtocolType.Ethereum,
        multiProvider,
      ),
      (_chain, addresses) => ({
        foreignDeployment: addresses.router,
      }),
    ),
  );

  console.log('configMap', configMap);
  console.log('deployer.cachedAddresses', deployer.cachedAddresses);
  console.log(
    'configMapWithForeignDeployments',
    configMapWithForeignDeployments,
  );

  // process.exit(1);

  try {
    await deployer.deploy(configMapWithForeignDeployments);
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

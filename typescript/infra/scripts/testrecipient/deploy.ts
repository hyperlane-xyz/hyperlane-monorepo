import path from 'path';

import { serializeContracts } from '@abacus-network/sdk';

import { TestRecipientDeployer } from '../../src/testrecipient';
import { writeJSON } from '../../src/utils/utils';
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

  const contracts = await deployer.deploy();
  writeJSON(dir, 'addresses.json', serializeContracts(contracts));
  writeJSON(dir, 'verification.json', deployer.verificationInputs);
}

main()
  .then(() => console.info('Deployment complete'))
  .catch(console.error);

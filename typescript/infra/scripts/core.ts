import {
  ChainMap,
  Chains,
  ContractVerificationInput,
  buildContracts,
  coreFactories,
  serializeContracts,
} from '@abacus-network/sdk';

import { AbacusCoreInfraDeployer } from '../src/core/deploy';
import { readJSON, writeJSON } from '../src/utils/utils';

import {
  getCoreContractsSdkFilepath,
  getCoreEnvironmentConfig,
  getCoreRustDirectory,
  getCoreVerificationDirectory,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment) as any;
  const multiProvider = await config.getMultiProvider();
  const deployer = new AbacusCoreInfraDeployer(multiProvider, config.core);

  let previousContracts = {};
  previousAddressParsing: try {
    if (environment === 'test') {
      break previousAddressParsing;
    }
    const addresses = readJSON(
      getCoreContractsSdkFilepath(),
      `${environment}.json`,
    );
    previousContracts = buildContracts(addresses, coreFactories);
  } catch (e) {
    console.info('Could not load partial core addresses, file may not exist');
  }

  try {
    await deployer.deploy(previousContracts);
  } catch (e) {
    console.error(`Encountered error during deploy`);
    console.error(e);
  }

  // Persist artifacts, irrespective of deploy success
  writeJSON(
    getCoreContractsSdkFilepath(),
    `${environment}.json`,
    serializeContracts(deployer.deployedContracts),
  );
  const existingVerificationInputs = readJSON(
    getCoreVerificationDirectory(environment),
    'verification.json',
  );
  writeJSON(
    getCoreVerificationDirectory(environment),
    'verification.json',
    deployer.mergeWithExistingVerificationInputs(existingVerificationInputs),
  );

  deployer.writeRustConfigs(environment, getCoreRustDirectory(environment));
}

main().then(console.log).catch(console.error);

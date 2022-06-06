import { serializeContracts } from '@abacus-network/sdk';

import { AbacusCoreInfraDeployer } from '../src/core/deploy';
import { writeJSON } from '../src/utils/utils';

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

  const contracts = await deployer.deploy();

  writeJSON(
    getCoreContractsSdkFilepath(),
    `${environment}.json`,
    serializeContracts(contracts),
  );
  writeJSON(
    getCoreVerificationDirectory(environment),
    'verification.json',
    deployer.verificationInputs,
  );
  deployer.writeRustConfigs(
    environment,
    getCoreRustDirectory(environment),
    contracts,
  );
}

main().then(console.log).catch(console.error);

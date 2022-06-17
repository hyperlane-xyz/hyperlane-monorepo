import {
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
  getEnvironmentDirectory,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment) as any;
  const multiProvider = await config.getMultiProvider();
  const deployer = new AbacusCoreInfraDeployer(multiProvider, config.core);

  const addresses = readJSON(
    getEnvironmentDirectory(environment),
    'partial_core_addresses.json',
  );
  const partial_contracts = buildContracts(addresses, coreFactories);

  try {
    const contracts = await deployer.deploy(partial_contracts);
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
  } catch (e) {
    console.error(e);
    // persist partial deployment
    writeJSON(
      getEnvironmentDirectory(environment),
      'partial_core_addresses.json',
      {
        ...serializeContracts(deployer.deployedContracts),
        ...serializeContracts(partial_contracts),
      },
    );
  }
}

main().then(console.log).catch(console.error);

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

function mergeVerificationInputs<ChainName extends Chains>(
  existingInputsMap: ChainMap<ChainName, ContractVerificationInput[]>,
  newInputsMap: ChainMap<ChainName, ContractVerificationInput[]>,
): ChainMap<ChainName, ContractVerificationInput[]> {
  const allChains = new Set<ChainName>();
  Object.keys(existingInputsMap).forEach((_) => allChains.add(_ as ChainName));
  Object.keys(newInputsMap).forEach((_) => allChains.add(_ as ChainName));

  // @ts-ignore
  const ret: ChainMap<ChainName, ContractVerificationInput[]> = {};
  for (const chain of allChains) {
    const existingInputs = existingInputsMap[chain] || [];
    const newInputs = newInputsMap[chain] || [];
    ret[chain] = [...existingInputs, ...newInputs];
  }
  return ret;
}

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
    mergeVerificationInputs(
      existingVerificationInputs,
      deployer.verificationInputs,
    ),
  );

  deployer.writeRustConfigs(environment, getCoreRustDirectory(environment));
}

main().then(console.log).catch(console.error);

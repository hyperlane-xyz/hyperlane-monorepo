import {
  MultiProvider,
  buildContracts,
  connectContractsMap,
  coreFactories,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreInfraDeployer } from '../src/core/deploy';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';
import { readJSON, writeJSON } from '../src/utils/utils';

import {
  assertEnvironment,
  getArgsWithFork,
  getCoreContractsSdkFilepath,
  getCoreEnvironmentConfig,
  getCoreRustDirectory,
  getCoreVerificationDirectory,
} from './utils';

async function main() {
  const argv = await getArgsWithFork().argv;
  const environment = assertEnvironment(argv.environment);
  const config = getCoreEnvironmentConfig(environment);

  const multiProvider =
    process.env.CI === 'true'
      ? new MultiProvider() // use default RPCs
      : await config.getMultiProvider();

  const deployer = new HyperlaneCoreInfraDeployer(
    multiProvider,
    config.core,
    environment,
  );

  let previousContracts = {};
  previousAddressParsing: try {
    if (environment === 'test') {
      break previousAddressParsing;
    }
    const addresses = readJSON(
      getCoreContractsSdkFilepath(),
      `${deployEnvToSdkEnv[environment]}.json`,
    );
    previousContracts = buildContracts(addresses, coreFactories);
    deployer.deployedContracts = connectContractsMap(
      previousContracts,
      multiProvider,
    );
  } catch (e) {
    console.info('Could not load partial core addresses, file may not exist');
  }

  if (argv.fork) {
    const { provider, network } = await useLocalProvider(multiProvider);

    const forkChain = network.name;
    console.log(`Running against ${forkChain} fork`);

    // TODO: make this more generic
    const deployerAddress =
      environment === 'testnet3'
        ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
        : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

    // rotate chain signer to impersonated deployer
    const signer = await impersonateAccount(provider, deployerAddress);
    multiProvider.setSigner(forkChain, signer);

    await deployer.deployContracts(network.name, config.core[forkChain]);
    return;
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
    `${deployEnvToSdkEnv[environment]}.json`,
    serializeContracts(deployer.deployedContracts),
  );
  const verificationDir = getCoreVerificationDirectory(environment);
  const verificationFile = 'verification.json';
  let existingVerificationInputs = [];
  try {
    existingVerificationInputs = readJSON(verificationDir, verificationFile);
  } catch (err) {
    /* ignore error */
  }

  writeJSON(
    getCoreVerificationDirectory(environment),
    'verification.json',
    deployer.mergeWithExistingVerificationInputs(existingVerificationInputs),
  );

  deployer.writeRustConfigs(getCoreRustDirectory());
}

main().then().catch(console.error);

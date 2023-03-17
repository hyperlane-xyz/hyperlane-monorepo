import {
  buildContracts,
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
  const multiProvider = await config.getMultiProvider();

  if (argv.fork) {
    await useLocalProvider(multiProvider, argv.fork);

    // TODO: make this more generic
    const deployerAddress =
      environment === 'testnet3'
        ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
        : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

    const signer = await impersonateAccount(deployerAddress);
    multiProvider.setSigner(argv.fork, signer);
  }

  const deployer = new HyperlaneCoreInfraDeployer(
    multiProvider,
    config.core,
    environment,
  );

  if (environment !== 'test') {
    try {
      const addresses = readJSON(
        getCoreContractsSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      );
      deployer.cacheContracts(buildContracts(addresses, coreFactories) as any);
    } catch (e) {
      console.info('Could not load partial core addresses, file may not exist');
    }
  }

  if (argv.fork) {
    await deployer.deployContracts(argv.fork, config.core[argv.fork]);
    return;
  }

  try {
    await deployer.deploy();
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

main()
  .then()
  .catch(() => process.exit(1));

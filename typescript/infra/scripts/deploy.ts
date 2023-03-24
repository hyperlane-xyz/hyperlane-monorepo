import {
  HyperlaneDeployer,
  HyperlaneFactories,
  buildAgentConfig,
  buildContracts,
  coreFactories,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import { igpFactories } from '@hyperlane-xyz/sdk/dist/gas/contracts';

import { deployEnvToSdkEnv } from '../src/config/environment';
import { HyperlaneCoreInfraDeployer } from '../src/core/deploy';
import { HyperlaneIgpInfraDeployer } from '../src/gas/deploy';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';
import { readJSON, writeJSON, writeMergedJSON } from '../src/utils/utils';

import {
  getAgentConfigDirectory,
  getArgsWithModuleAndFork,
  getContractAddressesSdkFilepath,
  getEnvironmentConfig,
  getVerificationDirectory,
} from './utils';

async function main() {
  const { module, fork, environment } = await getArgsWithModuleAndFork().argv;
  const config = await getEnvironmentConfig();
  const multiProvider = await config.getMultiProvider();

  if (fork) {
    await useLocalProvider(multiProvider, fork);

    // TODO: make this more generic
    const deployerAddress =
      environment === 'testnet3'
        ? '0xfaD1C94469700833717Fa8a3017278BC1cA8031C'
        : '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

    const signer = await impersonateAccount(deployerAddress);
    multiProvider.setSigner(fork, signer);
  }

  // Write agent config indexing from the latest block numbers.
  // For non-net-new deployments, these changes will need to be
  // reverted manually.
  const chains = multiProvider.getKnownChainNames();
  const startBlocks = Object.fromEntries(
    await Promise.all(
      chains.map(async (c) => [
        c,
        await multiProvider.getProvider(c).getBlockNumber,
      ]),
    ),
  );

  let factories: HyperlaneFactories;
  let deployer: HyperlaneDeployer<any, any, any>;
  if (module === 'core') {
    factories = coreFactories;
    deployer = new HyperlaneCoreInfraDeployer(
      multiProvider,
      config.core,
      environment,
    );
  } else if (module === 'igp') {
    factories = igpFactories;
    deployer = new HyperlaneIgpInfraDeployer(
      multiProvider,
      config.igp,
      environment,
    );
  } else {
    throw new Error('Unknown module type');
  }

  if (environment !== 'test') {
    try {
      const addresses = readJSON(
        getContractAddressesSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      );
      deployer.cacheContracts(buildContracts(addresses, factories) as any);
    } catch (e) {
      console.info('Could not load partial addresses, file may not exist');
    }
  }

  if (fork) {
    await deployer.deployContracts(fork, config.core[fork]);
    return;
  }

  try {
    await deployer.deploy();
  } catch (e) {
    console.error('Encountered error during deploy', e);
  }

  // Persist address artifacts, irrespective of deploy success
  writeMergedJSON(
    getContractAddressesSdkFilepath(),
    `${deployEnvToSdkEnv[environment]}.json`,
    serializeContracts(deployer.deployedContracts),
  );
  const verificationDir = getVerificationDirectory(environment, module);
  const verificationFile = 'verification.json';
  let existingVerificationInputs = [];
  try {
    existingVerificationInputs = readJSON(verificationDir, verificationFile);
  } catch (err) {
    /* ignore error */
  }

  writeJSON(
    verificationDir,
    verificationFile,
    deployer.mergeWithExistingVerificationInputs(existingVerificationInputs),
  );

  const sdkEnv = deployEnvToSdkEnv[environment];
  const addresses = readJSON(
    getContractAddressesSdkFilepath(),
    `${sdkEnv}.json`,
  );

  const agentConfig = await buildAgentConfig(
    multiProvider.getKnownChainNames(),
    multiProvider,
    addresses,
    startBlocks,
  );

  writeJSON(getAgentConfigDirectory(), `${sdkEnv}_config.json`, agentConfig);
}

main()
  .then(console.log)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

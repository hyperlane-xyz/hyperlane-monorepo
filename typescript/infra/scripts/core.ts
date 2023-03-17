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
import { mergeJSON, readJSON, writeJSON } from '../src/utils/utils';

import {
  getAgentConfigDirectory,
  getArgsWithModule,
  getContractAddressesSdkFilepath,
  getEnvironment,
  getEnvironmentConfig,
  getVerificationDirectory,
} from './utils';

async function main() {
  const { module } = await getArgsWithModule().argv;
  const environment = await getEnvironment();
  const config = await getEnvironmentConfig();
  const multiProvider = await config.getMultiProvider();

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
  switch (module) {
    case 'core': {
      factories = coreFactories;
      deployer = new HyperlaneCoreInfraDeployer(
        multiProvider,
        config.core,
        environment,
      );
      break;
    }
    case 'igp': {
      factories = igpFactories;
      deployer = new HyperlaneIgpInfraDeployer(
        multiProvider,
        config.igp,
        environment,
      );
      break;
    }
    default:
      throw new Error('Unknown module type');
  }
  let previousContracts = {};
  previousAddressParsing: try {
    if (environment === 'test') {
      console.info('Skipping loading partial addresses for test environment');
      break previousAddressParsing;
    }
    const addresses = readJSON(
      getContractAddressesSdkFilepath(),
      `${deployEnvToSdkEnv[environment]}.json`,
    );
    previousContracts = buildContracts(addresses, factories);
  } catch (e) {
    console.info('Could not load partial addresses, file may not exist');
  }

  try {
    await deployer.deploy(previousContracts);
  } catch (e) {
    console.error(`Encountered error during deploy`);
    console.error(e);
  }

  // Persist address artifacts, irrespective of deploy success
  mergeJSON(
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

main().then(console.log).catch(console.error);

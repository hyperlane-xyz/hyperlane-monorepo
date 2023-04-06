import {
  ChainMap,
  ChainName,
  HyperlaneAddresses,
  HyperlaneAgentAddresses,
  HyperlaneDeployer,
  MultiProvider,
  buildAgentConfig,
  objMap,
  promiseObjAll,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';

import { getAgentConfigDirectory } from '../scripts/utils';

import { DeployEnvironment, deployEnvToSdkEnv } from './config/environment';
import {
  readJSONAtPath,
  writeJSON,
  writeJsonAtPath,
  writeMergedJSONAtPath,
} from './utils/utils';

export async function writeAgentConfig(
  addressesPath: string,
  multiProvider: MultiProvider,
  environment: DeployEnvironment,
) {
  let addresses: ChainMap<HyperlaneAddresses<any>> = {};
  try {
    addresses = readJSONAtPath(addressesPath);
  } catch (e) {
    console.error('Failed to load cached addresses');
  }
  // Write agent config indexing from the deployed or latest block numbers.
  // For non-net-new deployments, these changes will need to be
  // reverted manually.
  const startBlocks = await promiseObjAll(
    objMap(addresses, (chain, _) =>
      multiProvider.getProvider(chain).getBlockNumber(),
    ),
  );
  const agentConfig = buildAgentConfig(
    multiProvider.getKnownChainNames(),
    multiProvider,
    addresses as ChainMap<HyperlaneAgentAddresses>,
    startBlocks,
  );
  const sdkEnv = deployEnvToSdkEnv[environment];
  writeJSON(getAgentConfigDirectory(), `${sdkEnv}_config.json`, agentConfig);
}

export async function deployWithArtifacts<Config>(
  configMap: ChainMap<Config>,
  deployer: HyperlaneDeployer<Config, any>,
  cache: {
    addresses: string;
    verification: string;
    read: boolean;
    write: boolean;
  },
  fork?: ChainName,
  agentConfig?: {
    multiProvider: MultiProvider;
    addresses: string;
    environment: DeployEnvironment;
  },
) {
  if (cache.read) {
    let addresses = {};
    try {
      addresses = readJSONAtPath(cache.addresses);
    } catch (e) {
      console.error('Failed to load cached addresses', e);
    }

    deployer.cacheAddresses(addresses);
  }

  try {
    if (fork) {
      await deployer.deployContracts(fork, configMap[fork]);
    } else {
      await deployer.deploy(configMap);
    }
  } catch (e) {
    console.error('Failed to deploy contracts', e);
  }

  if (cache.write) {
    // cache addresses of deployed contracts
    writeMergedJSONAtPath(
      cache.addresses,
      serializeContractsMap(deployer.deployedContracts),
    );

    let savedVerification = {};
    try {
      savedVerification = readJSONAtPath(cache.verification);
    } catch (e) {
      console.error('Failed to load cached verification inputs');
    }

    // cache verification inputs
    const inputs =
      deployer.mergeWithExistingVerificationInputs(savedVerification);
    writeJsonAtPath(cache.verification, inputs);
  }
  if (agentConfig) {
    await writeAgentConfig(
      agentConfig.addresses,
      agentConfig.multiProvider,
      agentConfig.environment,
    );
  }
}

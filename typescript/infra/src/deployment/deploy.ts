import {
  ChainMap,
  ChainName,
  HyperlaneAddresses,
  HyperlaneDeployer,
  HyperlaneDeploymentArtifacts,
  MultiProvider,
  buildAgentConfig,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import { objMap, objMerge, promiseObjAll } from '@hyperlane-xyz/utils';

import { getAgentConfigDirectory } from '../../scripts/utils';
import { DeployEnvironment } from '../config';
import { deployEnvToSdkEnv } from '../config/environment';
import {
  readJSONAtPath,
  writeJSON,
  writeJsonAtPath,
  writeMergedJSONAtPath,
} from '../utils/utils';

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
    agentConfigModuleAddressPaths: string[];
    environment: DeployEnvironment;
  },
) {
  if (cache.read) {
    let addressesMap = {};
    try {
      addressesMap = readJSONAtPath(cache.addresses);
    } catch (e) {
      console.error('Failed to load cached addresses');
    }

    deployer.cacheAddressesMap(addressesMap);
  }

  process.on('SIGINT', async () => {
    // Call the post deploy hook to write the addresses and verification
    await postDeploy(deployer, cache, agentConfig);

    console.log('\nCaught (Ctrl+C), gracefully exiting...');
    process.exit(0); // Exit the process
  });

  try {
    if (fork) {
      deployer.deployedContracts[fork] = await deployer.deployContracts(
        fork,
        configMap[fork],
      );
    } else {
      await deployer.deploy(configMap);
    }
  } catch (e) {
    console.error('Failed to deploy contracts', e);
  }

  await postDeploy(deployer, cache, agentConfig);
}

export async function postDeploy<Config>(
  deployer: HyperlaneDeployer<Config, any>,
  cache: {
    addresses: string;
    verification: string;
    read: boolean;
    write: boolean;
  },
  agentConfig?: {
    multiProvider: MultiProvider;
    agentConfigModuleAddressPaths: string[];
    environment: DeployEnvironment;
  },
) {
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
      agentConfig.agentConfigModuleAddressPaths,
      agentConfig.multiProvider,
      agentConfig.environment,
    );
  }
}

export async function writeAgentConfig(
  agentConfigModuleAddressPaths: string[],
  multiProvider: MultiProvider,
  environment: DeployEnvironment,
) {
  let addresses: ChainMap<HyperlaneAddresses<any>> = {};
  try {
    addresses = agentConfigModuleAddressPaths
      .map(readJSONAtPath)
      .reduce((acc, val) => objMerge(acc, val), {});
  } catch (e) {
    console.error(
      'Failed to load all required cached addresses, not writing agent config',
    );
    return;
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
    addresses as ChainMap<HyperlaneDeploymentArtifacts>,
    startBlocks,
  );
  const sdkEnv = deployEnvToSdkEnv[environment];
  writeJSON(getAgentConfigDirectory(), `${sdkEnv}_config.json`, agentConfig);
}

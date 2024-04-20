import {
  ChainMap,
  ChainName,
  HyperlaneCore,
  HyperlaneDeployer,
  HyperlaneDeploymentArtifacts,
  MultiProvider,
  buildAgentConfig,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import { objMap, objMerge, promiseObjAll } from '@hyperlane-xyz/utils';

import { getChainAddresses } from '../../config/registry.js';
import {
  Modules,
  getAddresses,
  getAgentConfigJsonPath,
  writeAddresses,
} from '../../scripts/agent-utils.js';
import {
  AgentEnvironment,
  DeployEnvironment,
  envNameToAgentEnv,
} from '../config/environment.js';
import {
  readJSONAtPath,
  writeJsonAtPath,
  writeMergedJSONAtPath,
} from '../utils/utils.js';

export async function deployWithArtifacts<Config extends object>(
  configMap: ChainMap<Config>,
  deployer: HyperlaneDeployer<Config, any>,
  cache: {
    verification: string;
    read: boolean;
    write: boolean;
    environment: DeployEnvironment;
    module: Modules;
  },
  targetNetwork?: ChainName,
  agentConfig?: {
    multiProvider: MultiProvider;
    environment: DeployEnvironment;
  },
) {
  if (cache.read) {
    const addressesMap = getAddresses(cache.environment, cache.module);
    deployer.cacheAddressesMap(addressesMap);
  }

  process.on('SIGINT', async () => {
    // Call the post deploy hook to write the addresses and verification
    await postDeploy(deployer, cache, agentConfig);

    console.log('\nCaught (Ctrl+C), gracefully exiting...');
    process.exit(0); // Exit the process
  });

  try {
    if (targetNetwork) {
      deployer.deployedContracts[targetNetwork] =
        await deployer.deployContracts(targetNetwork, configMap[targetNetwork]);
    } else {
      await deployer.deploy(configMap);
    }
  } catch (e) {
    console.error('Failed to deploy contracts', e);
  }

  await postDeploy(deployer, cache, agentConfig);
}

export async function postDeploy<Config extends object>(
  deployer: HyperlaneDeployer<Config, any>,
  cache: {
    verification: string;
    read: boolean;
    write: boolean;
    environment: DeployEnvironment;
    module: Modules;
  },
  agentConfig?: {
    multiProvider: MultiProvider;
    environment: DeployEnvironment;
  },
) {
  if (cache.write) {
    // TODO: dedupe deployedContracts with cachedAddresses
    const deployedAddresses = serializeContractsMap(deployer.deployedContracts);
    const cachedAddresses = deployer.cachedAddresses;
    const addresses = objMerge(deployedAddresses, cachedAddresses);

    // cache addresses of deployed contracts
    writeAddresses(cache.environment, cache.module, addresses);

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
      agentConfig.multiProvider,
      envNameToAgentEnv[agentConfig.environment],
    );
  }
}

export async function writeAgentConfig(
  multiProvider: MultiProvider,
  environment: AgentEnvironment,
) {
  const addresses = getChainAddresses();
  const core = HyperlaneCore.fromAddressesMap(addresses, multiProvider);
  // Write agent config indexing from the deployed Mailbox which stores the block number at deployment
  const startBlocks = await promiseObjAll(
    objMap(addresses, async (chain, _) => {
      // If the index.from is specified in the chain metadata, use that.
      const indexFrom = multiProvider.getChainMetadata(chain).index?.from;
      if (indexFrom !== undefined) {
        return indexFrom;
      }

      const mailbox = core.getContracts(chain).mailbox;
      const deployedBlock = await mailbox.deployedBlock();
      return deployedBlock.toNumber();
    }),
  );

  const agentConfig = buildAgentConfig(
    multiProvider.getKnownChainNames(),
    multiProvider,
    addresses as ChainMap<HyperlaneDeploymentArtifacts>,
    startBlocks,
  );
  writeMergedJSONAtPath(getAgentConfigJsonPath(environment), agentConfig);
}

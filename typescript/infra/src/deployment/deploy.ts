import chalk from 'chalk';

import {
  ChainMap,
  ChainName,
  HyperlaneContractsMap,
  HyperlaneDeployer,
  HyperlaneFactories,
  MultiProvider,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  objFilter,
  objMerge,
  runWithTimeout,
} from '@hyperlane-xyz/utils';

import {
  Modules,
  getAddresses,
  writeAddresses,
} from '../../scripts/agent-utils.js';
import { DeployEnvironment } from '../config/environment.js';
import { readJSONAtPath, writeJsonAtPath } from '../utils/utils.js';

enum DeployStatus {
  EMPTY = '🫥',
  SUCCESS = '✅',
  PENDING = '⏳',
  FAILURE = '❌',
}

const deployStatus: ChainMap<DeployStatus> = {};

const standardDeployModules = [
  Modules.PROXY_FACTORY,
  Modules.CORE,
  Modules.TEST_RECIPIENT,
  Modules.INTERCHAIN_GAS_PAYMASTER,
  Modules.HOOK,
];

export interface DeployCache {
  verification: string;
  read: boolean;
  write: boolean;
  environment: DeployEnvironment;
  module: Modules;
}

export async function deployWithArtifacts<Config extends object>({
  configMap,
  deployer,
  cache,
  targetNetworks,
  module,
  multiProvider,
  concurrentDeploy,
}: {
  configMap: ChainMap<Config>;
  deployer: HyperlaneDeployer<Config, any>;
  cache: DeployCache;
  targetNetworks: ChainName[];
  module: Modules;
  multiProvider: MultiProvider;
  concurrentDeploy: boolean;
}) {
  if (cache.read) {
    const addressesMap = getAddresses(cache.environment, cache.module);
    deployer.cacheAddressesMap(addressesMap);
  }

  // Filter the config map to only deploy the target networks
  const targetConfigMap =
    targetNetworks.length > 0
      ? objFilter(configMap, (chain, _): _ is Config =>
          targetNetworks.includes(chain),
        )
      : configMap;

  const handleExit = async () => {
    console.info(chalk.gray.italic('Running post-deploy steps'));
    await runWithTimeout(5000, () => postDeploy(deployer, cache))
      .then(() => console.info('Post-deploy completed'))
      .catch((error) => {
        console.error(
          chalk.red('Post-deploy steps timed out or failed'),
          error,
        );
      });

    if (Object.keys(deployStatus).length > 0) {
      const statusTable = Object.entries(deployStatus).map(
        ([chain, status]) => ({ chain, status: status ?? DeployStatus.EMPTY }),
      );
      console.table(statusTable);
    }

    // Force the exit after post-deploy steps
    process.exit(0);
  };

  // Handle Ctrl+C
  process.on('SIGINT', handleExit);
  // One final post-deploy before exit to ensure
  // deployments exceeding the timeout are still written
  process.on('beforeExit', handleExit);

  // Standard deploy modules are the ones that can be deployed with the
  // abstract HyperlaneDeployer's deploy function because they don't require any special logic
  if (standardDeployModules.includes(module)) {
    await baseDeploy(
      targetConfigMap,
      deployer,
      multiProvider,
      concurrentDeploy,
    );
  } else {
    try {
      await deployer.deploy(targetConfigMap);
    } catch (error: any) {
      if (error?.message.includes('Timed out')) {
        console.warn(
          chalk.yellow('Contract deployment exceeding configured timeout'),
          error,
        );
      } else {
        console.error(chalk.red('Contract deployment failed'), error);
      }
    }
  }
}

async function baseDeploy<
  Config extends object,
  Factories extends HyperlaneFactories,
>(
  configMap: ChainMap<Config>,
  deployer: HyperlaneDeployer<Config, Factories>,
  multiProvider: MultiProvider,
  concurrentDeploy: boolean,
): Promise<HyperlaneContractsMap<Factories>> {
  const configChains = Object.keys(configMap);
  const ethereumConfigChains = configChains.filter(
    (chain) =>
      multiProvider.getChainMetadata(chain).protocol === ProtocolType.Ethereum,
  );

  const targetChains = multiProvider.intersect(
    ethereumConfigChains,
    true,
  ).intersection;

  console.info(`Start deploy to ${targetChains}`);

  const deployPromises = targetChains.map(async (chain) => {
    const signerAddress = await multiProvider.getSignerAddress(chain);
    console.info(
      chalk.gray.italic(`Deploying to ${chain} from ${signerAddress}`),
    );

    return runWithTimeout(deployer.chainTimeoutMs, async () => {
      deployStatus[chain] = DeployStatus.PENDING;
      const contracts = await deployer.deployContracts(chain, configMap[chain]);
      deployer.deployedContracts[chain] = {
        ...deployer.deployedContracts[chain],
        ...contracts,
      };
      console.info(
        chalk.green.bold(`Successfully deployed contracts on ${chain}`),
      );
      deployStatus[chain] = DeployStatus.SUCCESS;
    }).catch((error) => {
      deployStatus[chain] = DeployStatus.FAILURE;
      console.error(
        chalk.red.bold(`Deployment failed on ${chain}. Error: ${error}`),
      );
    });
  });

  if (concurrentDeploy) {
    await Promise.all(deployPromises);
  } else {
    for (const promise of deployPromises) {
      await promise;
    }
  }

  return deployer.deployedContracts;
}

async function postDeploy<Config extends object>(
  deployer: HyperlaneDeployer<Config, any>,
  cache: DeployCache,
) {
  if (cache.write) {
    const deployedAddresses = serializeContractsMap(deployer.deployedContracts);
    const cachedAddresses = deployer.cachedAddresses;
    const addresses = objMerge(deployedAddresses, cachedAddresses);

    // cache addresses of deployed contracts
    writeAddresses(cache.environment, cache.module, addresses);

    let savedVerification = {};
    try {
      savedVerification = readJSONAtPath(cache.verification);
    } catch (e) {
      console.error(
        chalk.red('Failed to load cached verification inputs. Error: ', e),
      );
    }

    // merge with existing cache of verification inputs
    const mergedVerificationInputs =
      deployer.mergeWithExistingVerificationInputs(savedVerification);

    // deduplicate verification inputs for each chain
    const deduplicatedVerificationInputs = Object.fromEntries(
      Object.entries(mergedVerificationInputs).map(([chain, contracts]) => [
        chain,
        contracts.reduce((acc: any[], contract: any) => {
          if (!acc.some((c) => c.address === contract.address)) {
            acc.push(contract);
          }
          return acc;
        }, []),
      ]),
    );

    // write back deduplicated verification inputs
    writeJsonAtPath(cache.verification, deduplicatedVerificationInputs);
  }
}

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

enum Status {
  EMPTY = '🫥',
  SUCCESS = '✅',
  PENDING = '⏳',
  FAILURE = '❌',
}

const deployStatus: ChainMap<Status> = {};

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
  cache: {
    verification: string;
    read: boolean;
    write: boolean;
    environment: DeployEnvironment;
    module: Modules;
  };
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
  let targetConfigMap = configMap;
  if (targetNetworks.length > 0) {
    targetConfigMap = objFilter(configMap, (chain, _): _ is Config =>
      targetNetworks.includes(chain),
    );
  }

  const handleExit = async () => {
    console.info(chalk.gray.italic('Running post-deploy steps'));
    await postDeploy(deployer, cache);
    console.info('Post-deploy completed');

    if (Object.keys(deployStatus).length > 0) {
      const statusTable = Object.keys(configMap).map((chain) => {
        return {
          chain,
          status: deployStatus[chain] ?? Status.EMPTY,
        };
      });
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

  // proxyfactory(ism), core, testrecipient deploys
  // use the standard deploy loop
  if (
    module === Modules.PROXY_FACTORY ||
    module === Modules.CORE ||
    module === Modules.TEST_RECIPIENT
  ) {
    await baseDeploy(
      targetConfigMap,
      deployer,
      multiProvider,
      concurrentDeploy,
      cache,
    );
  } else {
    // ica and others may override deploy()
    // so we let the deployer do its thing
    try {
      await deployer.deploy(targetConfigMap);
    } catch (e: any) {
      if (e?.message.includes('Timed out')) {
        console.warn(
          chalk.yellow('Contract deployment exceeding configured timeout'),
          e,
        );
      } else {
        console.error(chalk.red('Contract deployment failed'), e);
      }
    }
  }

  // Call the post-deploy hook to write artifacts
  await postDeploy(deployer, cache);
}

async function baseDeploy<
  Config extends object,
  Factories extends HyperlaneFactories,
>(
  configMap: ChainMap<Config>,
  deployer: HyperlaneDeployer<Config, Factories>,
  multiProvider: MultiProvider,
  concurrentDeploy: boolean,
  cache: {
    verification: string;
    read: boolean;
    write: boolean;
    environment: DeployEnvironment;
    module: Modules;
  },
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

  const deployPromises = [];
  for (const chain of targetChains) {
    const signerAddress = await multiProvider.getSignerAddress(chain);
    console.info(
      chalk.gray.italic(`Deploying to ${chain} from ${signerAddress}`),
    );

    const deployPromise = runWithTimeout(deployer.chainTimeoutMs, async () => {
      deployStatus[chain] = Status.PENDING;
      const contracts = await deployer.deployContracts(chain, configMap[chain]);
      deployer.deployedContracts[chain] = {
        ...deployer.deployedContracts[chain],
        ...contracts,
      };
      console.info(
        chalk.green.bold(`Successfully deployed contracts on ${chain}`),
      );
      deployStatus[chain] = Status.SUCCESS;
    });

    if (concurrentDeploy) {
      deployPromises.push(deployPromise);
    } else {
      await deployPromise;
    }
  }

  // Await all deploy promises. If concurrent deploy is not enabled, this will be a no-op.
  const deployResults = await Promise.allSettled(deployPromises);
  for (const [i, result] of deployResults.entries()) {
    if (result.status === 'rejected') {
      deployStatus[targetChains[i]] = Status.FAILURE;
      console.error(
        chalk.red.bold(
          `Deployment failed on ${targetChains[i]}. Error: ${result.reason}`,
        ),
      );
    }
  }

  return deployer.deployedContracts;
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
      console.error(chalk.red('Failed to load cached verification inputs'));
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

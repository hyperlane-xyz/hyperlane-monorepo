import chalk from 'chalk';

import {
  ChainMap,
  ChainName,
  ContractVerificationInput,
  HyperlaneAddressesMap,
  HyperlaneContractsMap,
  HyperlaneDeployer,
  HyperlaneFactories,
  MultiProvider,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import {
  isEVMLike,
  objFilter,
  objMerge,
  runWithTimeout,
} from '@hyperlane-xyz/utils';
import { pathExists, readJson } from '@hyperlane-xyz/utils/fs';

import {
  Modules,
  getAddresses,
  writeAddresses,
} from '../../scripts/agent-utils.js';
import { DeployEnvironment } from '../config/deploy-environment.js';
import { writeAndFormatJsonAtPath } from '../utils/utils.js';

export enum DeployStatus {
  EMPTY = '🫥',
  SUCCESS = '✅',
  INFLIGHT = '⏳',
  FAILURE = '❌',
}

export interface DeploymentRun {
  status: ChainMap<DeployStatus>;
  interrupted: boolean;
}

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

export async function deployWithArtifacts<
  Config extends object,
  Factories extends HyperlaneFactories,
>({
  configMap,
  deployer,
  cache,
  targetNetworks,
  module,
  multiProvider,
  concurrentDeploy,
}: {
  configMap: ChainMap<Config>;
  deployer: HyperlaneDeployer<Config, Factories>;
  cache: DeployCache;
  targetNetworks: ChainName[];
  module: Modules;
  multiProvider: MultiProvider;
  concurrentDeploy: boolean;
}) {
  const run: DeploymentRun = { status: {}, interrupted: false };
  const targetConfigMap =
    targetNetworks.length > 0
      ? objFilter(configMap, (chain, _): _ is Config =>
          targetNetworks.includes(chain),
        )
      : configMap;
  const handleInterrupt = () => {
    run.interrupted = true;
    console.warn(
      'Deployment interrupted; draining admitted work before saving artifacts',
    );
  };
  process.on('SIGINT', handleInterrupt);
  let failed = false;
  try {
    if (cache.read) {
      deployer.cacheAddressesMap(getAddresses(cache.environment, cache.module));
    }
    if (standardDeployModules.includes(module)) {
      await baseDeploy(
        targetConfigMap,
        deployer,
        multiProvider,
        concurrentDeploy,
        (chain) => writeDeploymentAddresses(deployer, cache, [chain]),
        run,
      );
    } else {
      const targetChains = getDeployChains(targetConfigMap, multiProvider);
      for (const chain of targetChains)
        run.status[chain] = DeployStatus.INFLIGHT;
      try {
        await deployer.deploy(targetConfigMap);
        for (const chain of targetChains)
          run.status[chain] = DeployStatus.SUCCESS;
      } catch (error: unknown) {
        for (const chain of targetChains)
          run.status[chain] = DeployStatus.FAILURE;
        throw error;
      }
    }
  } catch (error: unknown) {
    failed = true;
    console.error(chalk.red('Contract deployment failed'), error);
  }

  try {
    // This is the only artifact flush/exit owner. Interrupts stop admission;
    // they cannot cancel already-broadcast transactions or race this flush.
    console.info(chalk.gray.italic('Running post-deploy steps'));
    await postDeploy(deployer, cache, targetNetworks);
    console.info('Post-deploy completed');
  } catch (error: unknown) {
    failed = true;
    console.error(chalk.red('Post-deploy steps failed'), error);
  } finally {
    process.off('SIGINT', handleInterrupt);
  }

  const statuses = Object.entries(run.status);
  if (statuses.length > 0)
    console.table(statuses.map(([chain, status]) => ({ chain, status })));
  const failedChains = statuses
    .filter(([, status]) => status !== DeployStatus.SUCCESS)
    .map(([chain]) => chain);
  if (failedChains.length > 0) {
    failed = true;
    console.error(
      chalk.red.bold(
        `Deployment did not complete successfully on: ${failedChains.join(' ')}`,
      ),
    );
  }
  if (!failed && !run.interrupted) {
    console.info(
      chalk.green.bold(
        `Successfully deployed contracts on ${statuses.length} chains`,
      ),
    );
  }
  process.exit(run.interrupted ? 130 : failed ? 1 : 0);
}

export async function baseDeploy<
  Config extends object,
  Factories extends HyperlaneFactories,
>(
  configMap: ChainMap<Config>,
  deployer: HyperlaneDeployer<Config, Factories>,
  multiProvider: MultiProvider,
  concurrentDeploy: boolean,
  onChainSettled?: (chain: ChainName) => void | Promise<void>,
  run: DeploymentRun = { status: {}, interrupted: false },
): Promise<HyperlaneContractsMap<Factories>> {
  const targetChains = getDeployChains(configMap, multiProvider);
  for (const chain of targetChains) run.status[chain] = DeployStatus.EMPTY;
  console.info(`Start deploy to ${targetChains}`);

  const deployChain = async (chain: ChainName) => {
    if (run.interrupted) return;
    run.status[chain] = DeployStatus.INFLIGHT;
    const work = (async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      console.info(
        chalk.gray.italic(`Deploying to ${chain} from ${signerAddress}`),
      );
      const contracts = await deployer.deployContracts(chain, configMap[chain]);
      deployer.deployedContracts[chain] = {
        ...deployer.deployedContracts[chain],
        ...contracts,
      };
    })();
    try {
      await runWithTimeout(deployer.chainTimeoutMs, () => work);
      run.status[chain] = DeployStatus.SUCCESS;
      console.info(
        chalk.green.bold(`Successfully deployed contracts on ${chain}`),
      );
    } catch (error: unknown) {
      run.status[chain] = DeployStatus.FAILURE;
      console.error(chalk.red.bold(`Deployment failed on ${chain}`), error);
      // Timeout is not cancellation. Keep ownership until work settles so a
      // late deployment cannot race persistence or a new run.
      await Promise.allSettled([work]);
    }
    try {
      await onChainSettled?.(chain);
    } catch (error: unknown) {
      run.status[chain] = DeployStatus.FAILURE;
      console.error(
        chalk.red(`Failed to persist deployment on ${chain}`),
        error,
      );
    }
  };
  if (concurrentDeploy) {
    await Promise.all(targetChains.map(deployChain));
  } else {
    for (const chain of targetChains) await deployChain(chain);
  }
  return deployer.deployedContracts;
}

function getDeployChains<Config extends object>(
  configMap: ChainMap<Config>,
  multiProvider: MultiProvider,
): ChainName[] {
  const ethereumConfigChains = Object.keys(configMap).filter((chain) =>
    isEVMLike(multiProvider.getChainMetadata(chain).protocol),
  );
  const targetChains = multiProvider.intersect(
    ethereumConfigChains,
    true,
  ).intersection;
  return targetChains;
}

async function postDeploy<
  Config extends object,
  Factories extends HyperlaneFactories,
>(
  deployer: HyperlaneDeployer<Config, Factories>,
  cache: DeployCache,
  targetNetworks: ChainName[],
) {
  if (!cache.write) return;
  const errors: unknown[] = [];
  try {
    writeDeploymentAddresses(deployer, cache, targetNetworks);
  } catch (error: unknown) {
    errors.push(error);
  }
  try {
    const savedVerification = pathExists(cache.verification)
      ? readJson<ChainMap<ContractVerificationInput[]>>(cache.verification)
      : {};
    const merged =
      deployer.mergeWithExistingVerificationInputs(savedVerification);
    const deduplicated = Object.fromEntries(
      Object.entries(merged).map(([chain, contracts]) => [
        chain,
        contracts.filter(
          (contract, index) =>
            contracts.findIndex(
              (candidate) => candidate.address === contract.address,
            ) === index,
        ),
      ]),
    );
    await writeAndFormatJsonAtPath(cache.verification, deduplicated);
  } catch (error: unknown) {
    errors.push(error);
  }
  if (errors.length > 0)
    throw new AggregateError(errors, 'Failed to persist deployment artifacts');
}

function writeDeploymentAddresses<
  Config extends object,
  Factories extends HyperlaneFactories,
>(
  deployer: HyperlaneDeployer<Config, Factories>,
  cache: DeployCache,
  targetNetworks: ChainName[],
) {
  if (!cache.write) {
    return;
  }

  const chains = getAddressWriteChains(deployer, targetNetworks);

  const errors: unknown[] = [];
  for (const chain of chains) {
    let deployedAddresses: HyperlaneAddressesMap<Factories> = {};
    const deployedContracts = deployer.deployedContracts[chain];

    if (deployedContracts) {
      try {
        deployedAddresses = serializeContractsMap({
          [chain]: deployedContracts,
        });
      } catch (error) {
        errors.push(error);
        console.error(
          chalk.red(
            `Failed to serialize deployed contracts for ${chain}; writing cached addresses only`,
          ),
          error,
        );
      }
    }

    const cachedAddresses = deployer.cachedAddresses[chain]
      ? { [chain]: deployer.cachedAddresses[chain] }
      : {};
    const addresses = objMerge(deployedAddresses, cachedAddresses);

    if (Object.keys(addresses).length === 0) {
      continue;
    }

    try {
      writeAddresses(cache.environment, cache.module, addresses, [chain]);
    } catch (error) {
      errors.push(error);
      console.error(chalk.red(`Failed to write addresses for ${chain}`), error);
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, 'Failed to persist deployment addresses');
}

function getAddressWriteChains<
  Config extends object,
  Factories extends HyperlaneFactories,
>(
  deployer: HyperlaneDeployer<Config, Factories>,
  targetNetworks: ChainName[],
): ChainName[] {
  const chains = new Set([
    ...Object.keys(deployer.deployedContracts),
    ...Object.keys(deployer.cachedAddresses),
  ]);

  if (targetNetworks.length > 0) {
    return targetNetworks.filter((chain) => chains.has(chain));
  }

  return Array.from(chains);
}

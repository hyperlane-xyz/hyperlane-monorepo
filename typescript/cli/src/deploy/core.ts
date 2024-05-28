import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import { ChainAddresses, IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainName,
  CoreConfig,
  HooksConfig,
  HyperlaneAddressesMap,
  HyperlaneContractsMap,
  HyperlaneCore,
  HyperlaneCoreDeployer,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  IgpConfig,
  IsmConfig,
  IsmType,
  MultisigConfig,
  RoutingIsmConfig,
  buildAgentConfig,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap, objMerge } from '@hyperlane-xyz/utils';

import { presetHookConfigs, readHooksConfigMap } from '../config/hooks.js';
import { readIsmConfig } from '../config/ism.js';
import { readMultisigConfig } from '../config/multisig.js';
import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import {
  log,
  logBlue,
  logBoldUnderlinedRed,
  logGray,
  logGreen,
  logRed,
} from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { runFileSelectionStep, writeJson } from '../utils/files.js';

import {
  completeDeploy,
  isISMConfig,
  isZODISMConfig,
  prepareDeploy,
  runPreflightChecksForChains,
} from './utils.js';

const CONTRACT_CACHE_EXCLUSIONS = ['interchainGasPaymaster'];

/**
 * Executes the core deploy command.
 */
export async function runCoreDeploy({
  context,
  chains,
  ismConfigPath,
  hookConfigPath,
  agentOutPath,
}: {
  context: WriteCommandContext;
  chains?: ChainName[];
  ismConfigPath?: string;
  hookConfigPath?: string;
  agentOutPath: string;
}) {
  const { chainMetadata, signer, dryRunChain, skipConfirmation } = context;

  if (dryRunChain) chains = [dryRunChain];
  else if (!chains?.length) {
    if (skipConfirmation) throw new Error('No chains provided');
    chains = await runMultiChainSelectionStep(
      chainMetadata,
      'Select chains to connect:',
      true,
    );
  }

  const result = await runIsmStep(chains, skipConfirmation, ismConfigPath);
  // we can either specify the full ISM config or just the multisig config
  const isIsmConfig = isISMConfig(result);
  const ismConfigs = isIsmConfig ? (result as ChainMap<IsmConfig>) : undefined;
  const multisigConfigs = isIsmConfig
    ? defaultMultisigConfigs
    : (result as ChainMap<MultisigConfig>);
  const hooksConfig = await runHookStep(chains, hookConfigPath);

  const deploymentParams: DeployParams = {
    context,
    chains,
    ismConfigs,
    multisigConfigs,
    hooksConfig,
    agentOutPath,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    minGas: MINIMUM_CORE_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, chains);

  await executeDeploy(deploymentParams);

  await completeDeploy(context, 'core', initialBalances, userAddress, chains);
}

async function runIsmStep(
  selectedChains: ChainName[],
  skipConfirmation: boolean,
  ismConfigPath?: string,
) {
  if (!ismConfigPath) {
    logBlue(
      '\n',
      'Hyperlane instances requires an Interchain Security Module (ISM).',
    );
    logGray(
      'Example config: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/cli/typescript/cli/examples/ism.yaml',
    );
    if (skipConfirmation) throw new Error('ISM config required');
    ismConfigPath = await runFileSelectionStep(
      './configs',
      'ISM config',
      'ism',
    );
  }

  const isAdvancedIsm = isZODISMConfig(ismConfigPath);
  // separate flow for 'ism' and 'ism-advanced' options
  if (isAdvancedIsm) {
    logBoldUnderlinedRed(
      'WARNING: YOU ARE DEPLOYING WITH AN ADVANCED ISM CONFIG',
    );
    logRed(
      'Advanced ISM configs require knowledge of different ISM types and how they work together topologically. If possible, use the basic ISM configs are recommended.',
    );
    const ismConfig = readIsmConfig(ismConfigPath);
    const requiredIsms = objFilter(
      ismConfig,
      (chain, config): config is IsmConfig => selectedChains.includes(chain),
    );
    // selected chains - (user configs + default configs) = missing config
    const missingConfigs = selectedChains.filter(
      (c) => !Object.keys(ismConfig).includes(c),
    );
    if (missingConfigs.length > 0) {
      throw new Error(
        `Missing advanced ISM config for one or more chains: ${missingConfigs.join(
          ', ',
        )}`,
      );
    }

    log(`Found configs for chains: ${selectedChains.join(', ')}`);
    return requiredIsms as ChainMap<IsmConfig>;
  } else {
    const multisigConfigs = {
      ...defaultMultisigConfigs,
      ...readMultisigConfig(ismConfigPath),
    } as ChainMap<MultisigConfig>;
    const requiredMultisigs = objFilter(
      multisigConfigs,
      (chain, config): config is MultisigConfig =>
        selectedChains.includes(chain),
    );
    // selected chains - (user configs + default configs) = missing config
    const missingConfigs = selectedChains.filter(
      (c) => !Object.keys(requiredMultisigs).includes(c),
    );
    if (missingConfigs.length > 0) {
      throw new Error(
        `Missing ISM config for one or more chains: ${missingConfigs.join(
          ', ',
        )}`,
      );
    }

    log(`Found configs for chains: ${selectedChains.join(', ')}`);
    return requiredMultisigs as ChainMap<MultisigConfig>;
  }
}

async function runHookStep(
  _selectedChains: ChainName[],
  hookConfigPath?: string,
) {
  if (!hookConfigPath) return {};
  return readHooksConfigMap(hookConfigPath);
}

interface DeployParams {
  context: WriteCommandContext;
  chains: ChainName[];
  ismConfigs?: ChainMap<IsmConfig>;
  multisigConfigs?: ChainMap<MultisigConfig>;
  hooksConfig?: ChainMap<HooksConfig>;
  agentOutPath: string;
}

async function runDeployPlanStep({ context, chains }: DeployParams) {
  const { signer, skipConfirmation } = context;
  const address = await signer.getAddress();

  logBlue('\nDeployment plan');
  logGray('===============');
  log(`Transaction signer and owner of new contracts will be ${address}`);
  log(`Deploying to ${chains.join(', ')}`);
  log(
    `There are several contracts required for each chain but contracts in your provided registries will be skipped`,
  );

  if (skipConfirmation) return;
  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy({
  context,
  chains,
  ismConfigs = {},
  multisigConfigs = {},
  hooksConfig = {},
  agentOutPath,
}: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');
  const { signer, multiProvider, registry } = context;

  let chainAddresses = await registry.getAddresses();
  chainAddresses = filterAddressesToCache(chainAddresses);

  const owner = await signer.getAddress();
  let artifacts: HyperlaneAddressesMap<any> = {};

  // 1. Deploy ISM factories to all deployable chains that don't have them.
  logBlue('Deploying ISM factory contracts');
  const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
  ismFactoryDeployer.cacheAddressesMap(chainAddresses);

  const ismFactoryConfig = chains.reduce((chainMap, curr) => {
    chainMap[curr] = {};
    return chainMap;
  }, {} as ChainMap<{}>);
  const ismFactoryContracts = await ismFactoryDeployer.deploy(ismFactoryConfig);

  artifacts = await updateChainAddresses(
    registry,
    ismFactoryContracts,
    artifacts,
    context.isDryRun,
  );

  logGreen('ISM factory contracts deployed');

  // Build an IsmFactory that covers all chains so that we can
  // use it to deploy ISMs to remote chains.
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    chainAddresses,
    multiProvider,
  );
  // 3. Construct ISM configs for all deployable chains
  const defaultIsms: ChainMap<IsmConfig> = {};
  for (const ismOrigin of chains) {
    defaultIsms[ismOrigin] =
      ismConfigs[ismOrigin] ??
      buildIsmConfig(owner, ismOrigin, chains, multisigConfigs);
  }

  // 4. Deploy core contracts to chains
  logBlue(`Deploying core contracts to ${chains.join(', ')}`);
  const coreDeployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  coreDeployer.cacheAddressesMap(chainAddresses as any);
  const coreConfigs = buildCoreConfigMap(
    owner,
    chains,
    defaultIsms,
    hooksConfig,
  );
  const coreContracts = await coreDeployer.deploy(coreConfigs);

  // 4.5 recover the toplevel ISM address
  const isms: HyperlaneAddressesMap<any> = {};
  for (const chain of chains) {
    isms[chain] = {
      interchainSecurityModule:
        coreDeployer.cachedAddresses[chain].interchainSecurityModule,
    };
  }
  artifacts = objMerge(artifacts, isms);
  artifacts = await updateChainAddresses(
    registry,
    coreContracts,
    artifacts,
    context.isDryRun,
  );
  logGreen('✅ Core contracts deployed');
  log(JSON.stringify(artifacts, null, 2));

  await writeAgentConfig(context, artifacts, chains, agentOutPath);

  logBlue('Deployment is complete!');
}

function filterAddressesToCache(addressesMap: ChainMap<ChainAddresses>) {
  // Filter out the certain addresses that must always be
  // deployed when deploying to a PI chain.
  // See https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/2983
  // And https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/3183
  return objMap(addressesMap, (_chain, addresses) =>
    objFilter(
      addresses,
      (contract, _address): _address is string =>
        !CONTRACT_CACHE_EXCLUSIONS.includes(contract),
    ),
  );
}

function buildIsmConfig(
  owner: Address,
  local: ChainName,
  chains: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigConfig>,
): RoutingIsmConfig {
  const aggregationIsmConfigs = buildAggregationIsmConfigs(
    local,
    chains,
    multisigIsmConfigs,
  );
  return {
    owner,
    type: IsmType.ROUTING,
    domains: aggregationIsmConfigs,
  };
}

function buildCoreConfigMap(
  owner: Address,
  chains: ChainName[],
  defaultIsms: ChainMap<IsmConfig>,
  hooksConfig: ChainMap<HooksConfig>,
): ChainMap<CoreConfig> {
  return chains.reduce<ChainMap<CoreConfig>>((config, chain) => {
    const hooks = hooksConfig[chain] ?? presetHookConfigs(owner);
    config[chain] = {
      owner,
      defaultIsm: defaultIsms[chain],
      defaultHook: hooks.default,
      requiredHook: hooks.required,
    };
    return config;
  }, {});
}

export function buildIgpConfigMap(
  owner: Address,
  chains: ChainName[],
  multisigConfigs: ChainMap<MultisigConfig>,
): ChainMap<IgpConfig> {
  const configMap: ChainMap<IgpConfig> = {};
  for (const chain of chains) {
    const overhead: ChainMap<number> = {};
    for (const remote of chains) {
      if (chain === remote) continue;
      // TODO: accurate estimate of gas from ChainMap<ISMConfig>
      const threshold = multisigConfigs[remote]
        ? multisigConfigs[remote].threshold
        : 2;
      const validatorsLength = multisigConfigs[remote]
        ? multisigConfigs[remote].validators.length
        : 3;
      overhead[remote] = multisigIsmVerificationCost(
        threshold,
        validatorsLength,
      );
    }
    configMap[chain] = {
      owner,
      beneficiary: owner,
      overhead,
      oracleKey: owner,
    };
  }
  return configMap;
}

async function updateChainAddresses(
  registry: IRegistry,
  newContracts: HyperlaneContractsMap<any>,
  otherAddresses: HyperlaneAddressesMap<any>,
  isDryRun?: boolean,
) {
  let newAddresses = serializeContractsMap(newContracts);
  // The HyperlaneCoreDeployer is returning a nested object with ISM addresses
  // from other chains, which don't need to be in the artifacts atm.
  newAddresses = objMap(newAddresses, (_, newChainAddresses) => {
    // For each chain in the addresses chainmap, filter the values to those that are just strings
    return objFilter(
      newChainAddresses,
      (_, value): value is string => typeof value === 'string',
    );
  });
  const mergedAddresses = objMerge(otherAddresses, newAddresses);

  if (isDryRun) return mergedAddresses;

  for (const chainName of Object.keys(newContracts)) {
    await registry.updateChain({
      chainName,
      addresses: mergedAddresses[chainName],
    });
  }
  return mergedAddresses;
}

async function writeAgentConfig(
  context: WriteCommandContext,
  artifacts: HyperlaneAddressesMap<any>,
  chains: ChainName[],
  outPath: string,
) {
  if (context.isDryRun) return;
  log('Writing agent configs');
  const { multiProvider, registry } = context;
  const startBlocks: ChainMap<number> = {};
  const core = HyperlaneCore.fromAddressesMap(artifacts, multiProvider);

  for (const chain of chains) {
    const mailbox = core.getContracts(chain).mailbox;
    startBlocks[chain] = (await mailbox.deployedBlock()).toNumber();
  }

  const chainAddresses = await registry.getAddresses();
  for (const chain of chains) {
    if (!chainAddresses[chain].interchainGasPaymaster) {
      chainAddresses[chain].interchainGasPaymaster =
        ethers.constants.AddressZero;
    }
  }
  const agentConfig = buildAgentConfig(
    chains, // Use only the chains that were deployed to
    multiProvider,
    chainAddresses as any,
    startBlocks,
  );
  writeJson(outPath, agentConfig);
  logGreen('Agent configs written');
}

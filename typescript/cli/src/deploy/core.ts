import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  CoreConfig,
  DeployedIsm,
  GasOracleContractType,
  HooksConfig,
  HyperlaneAddressesMap,
  HyperlaneContractsMap,
  HyperlaneCore,
  HyperlaneCoreDeployer,
  HyperlaneDeploymentArtifacts,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  IgpConfig,
  IsmConfig,
  IsmType,
  MultiProvider,
  MultisigConfig,
  RoutingIsmConfig,
  buildAgentConfig,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMerge } from '@hyperlane-xyz/utils';

import { runDeploymentArtifactStep } from '../config/artifacts.js';
import { presetHookConfigs, readHooksConfigMap } from '../config/hooks.js';
import { readIsmConfig } from '../config/ism.js';
import { readMultisigConfig } from '../config/multisig.js';
import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import {
  getContext,
  getDryRunContext,
  getMergedContractAddresses,
  sdkContractAddressesMap,
} from '../context.js';
import {
  log,
  logBlue,
  logBoldUnderlinedRed,
  logGray,
  logGreen,
  logRed,
} from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import {
  ArtifactsFile,
  prepNewArtifactsFiles,
  runFileSelectionStep,
  writeJson,
} from '../utils/files.js';
import { resetFork } from '../utils/fork.js';

import {
  isISMConfig,
  isZODISMConfig,
  runPreflightChecksForChains,
} from './utils.js';

/**
 * Executes the core deploy command.
 */
export async function runCoreDeploy({
  key,
  chainConfigPath,
  chains,
  ismConfigPath,
  hookConfigPath,
  artifactsPath,
  outPath,
  skipConfirmation,
  dryRun,
}: {
  key: string;
  chainConfigPath: string;
  chains?: ChainName[];
  ismConfigPath?: string;
  hookConfigPath?: string;
  artifactsPath?: string;
  outPath: string;
  skipConfirmation: boolean;
  dryRun: boolean;
}) {
  const context = dryRun
    ? await getDryRunContext({
        chainConfigPath,
        chains,
        keyConfig: { key },
        skipConfirmation,
      })
    : await getContext({
        chainConfigPath,
        keyConfig: { key },
        skipConfirmation,
      });

  const customChains = context.customChains;
  const multiProvider = context.multiProvider;
  const signer = context.signer;

  if (dryRun) chains = context.chains;
  else if (!chains?.length) {
    if (skipConfirmation) throw new Error('No chains provided');
    chains = await runMultiChainSelectionStep(
      customChains,
      'Select chains to connect:',
      true,
    );
  }

  const artifacts = await runArtifactStep(
    chains,
    skipConfirmation,
    artifactsPath,
  );
  const result = await runIsmStep(chains, skipConfirmation, ismConfigPath);
  // we can either specify the full ISM config or just the multisig config
  const isIsmConfig = isISMConfig(result);
  const ismConfigs = isIsmConfig ? (result as ChainMap<IsmConfig>) : undefined;
  const multisigConfigs = isIsmConfig
    ? defaultMultisigConfigs
    : (result as ChainMap<MultisigConfig>);
  const hooksConfig = await runHookStep(chains, hookConfigPath);

  const deploymentParams: DeployParams = {
    chains,
    signer,
    multiProvider,
    artifacts,
    ismConfigs,
    multisigConfigs,
    hooksConfig,
    outPath,
    skipConfirmation,
    dryRun,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    minGas: MINIMUM_CORE_DEPLOY_GAS,
  });
  await executeDeploy(deploymentParams);

  if (dryRun) await resetFork();
}

function runArtifactStep(
  selectedChains: ChainName[],
  skipConfirmation: boolean,
  artifactsPath?: string,
  dryRun?: boolean,
) {
  logBlue(
    '\nDeployments can be totally new or can use some existing contract addresses.',
  );
  return runDeploymentArtifactStep({
    artifactsPath,
    selectedChains,
    skipConfirmation,
    dryRun,
  });
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
  chains: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  artifacts?: HyperlaneAddressesMap<any>;
  ismConfigs?: ChainMap<IsmConfig>;
  multisigConfigs?: ChainMap<MultisigConfig>;
  hooksConfig?: ChainMap<HooksConfig>;
  outPath: string;
  skipConfirmation: boolean;
  dryRun: boolean;
}

async function runDeployPlanStep({
  chains,
  signer,
  artifacts,
  skipConfirmation,
}: DeployParams) {
  const address = await signer.getAddress();

  logBlue('\nDeployment plan');
  logGray('===============');
  log(`Transaction signer and owner of new contracts will be ${address}`);
  log(`Deploying to ${chains.join(', ')}`);
  log(
    `There are several contracts required for each chain but contracts in the Hyperlane SDK ${
      artifacts ? 'or your artifacts ' : ''
    }will be skipped`,
  );

  if (skipConfirmation) return;
  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy({
  chains,
  signer,
  multiProvider,
  outPath,
  artifacts = {},
  ismConfigs = {},
  multisigConfigs = {},
  hooksConfig = {},
  dryRun,
}: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');

  const [contractsFilePath, agentFilePath] = prepNewArtifactsFiles(
    outPath,
    getArtifactsFiles(dryRun),
  );

  const owner = await signer.getAddress();
  const mergedContractAddrs = getMergedContractAddresses(artifacts, chains);

  // 1. Deploy ISM factories to all deployable chains that don't have them.
  logBlue('Deploying ISM factory contracts');
  const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
  ismFactoryDeployer.cacheAddressesMap(mergedContractAddrs);

  const ismFactoryConfig = chains.reduce((chainMap, curr) => {
    chainMap[curr] = {};
    return chainMap;
  }, {} as ChainMap<{}>);
  const ismFactoryContracts = await ismFactoryDeployer.deploy(ismFactoryConfig);

  artifacts = writeMergedAddresses(
    contractsFilePath,
    artifacts,
    ismFactoryContracts,
  );
  logGreen('ISM factory contracts deployed');

  // Build an IsmFactory that covers all chains so that we can
  // use it to deploy ISMs to remote chains.
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );
  // 3. Construct ISM configs for all deployable chains
  const ismContracts: ChainMap<{ interchainSecurityModule: DeployedIsm }> = {};
  const defaultIsms: ChainMap<IsmConfig> = {};
  for (const ismOrigin of chains) {
    defaultIsms[ismOrigin] =
      ismConfigs[ismOrigin] ??
      buildIsmConfig(owner, ismOrigin, chains, multisigConfigs);
  }
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, ismContracts);

  // 4. Deploy core contracts to chains
  logBlue(`Deploying core contracts to ${chains.join(', ')}`);
  const coreDeployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  coreDeployer.cacheAddressesMap(mergedContractAddrs as any);
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
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, coreContracts);
  logGreen('Core contracts deployed');

  log('Writing agent configs');
  await writeAgentConfig(agentFilePath, artifacts, chains, multiProvider);
  logGreen('Agent configs written');

  logBlue('Deployment is complete!');
  logBlue(`Contract address artifacts are in ${contractsFilePath}`);
  logBlue(`Agent configs are in ${agentFilePath}`);
}

/**
 * Retrieves artifacts file metadata for the current command.
 * @param dryRun whether or not the current command is being dry-run
 * @returns the artifacts files
 */
function getArtifactsFiles(dryRun: boolean): Array<ArtifactsFile> {
  const coreDeploymentFile = {
    filename: dryRun ? 'dry-run_core-deployment' : 'core-deployment',
    description: 'Contract addresses',
  };
  const agentConfigFile = {
    filename: dryRun ? 'dry-run_agent-config' : 'agent-config',
    description: 'Agent configs',
  };

  return [coreDeploymentFile, agentConfigFile];
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
    const gasOracleType: ChainMap<GasOracleContractType> = {};
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
      gasOracleType[remote] = GasOracleContractType.StorageGasOracle;
    }
    configMap[chain] = {
      owner,
      beneficiary: owner,
      gasOracleType,
      overhead,
      oracleKey: owner,
    };
  }
  return configMap;
}

function writeMergedAddresses(
  filePath: string,
  aAddresses: HyperlaneAddressesMap<any>,
  bContracts: HyperlaneContractsMap<any>,
): HyperlaneAddressesMap<any> {
  const bAddresses = serializeContractsMap(bContracts);
  const mergedAddresses = objMerge(aAddresses, bAddresses);
  writeJson(filePath, mergedAddresses);
  return mergedAddresses;
}

async function writeAgentConfig(
  filePath: string,
  artifacts: HyperlaneAddressesMap<any>,
  chains: ChainName[],
  multiProvider: MultiProvider,
) {
  const startBlocks: ChainMap<number> = {};
  const core = HyperlaneCore.fromAddressesMap(artifacts, multiProvider);

  for (const chain of chains) {
    const mailbox = core.getContracts(chain).mailbox;
    startBlocks[chain] = (await mailbox.deployedBlock()).toNumber();
  }

  const mergedAddressesMap = objMerge(
    sdkContractAddressesMap,
    artifacts,
  ) as ChainMap<HyperlaneDeploymentArtifacts>;

  for (const chain of chains) {
    if (!mergedAddressesMap[chain].interchainGasPaymaster) {
      mergedAddressesMap[chain].interchainGasPaymaster =
        ethers.constants.AddressZero;
    }
  }
  const agentConfig = buildAgentConfig(
    chains, // Use only the chains that were deployed to
    multiProvider,
    mergedAddressesMap,
    startBlocks,
  );
  writeJson(filePath, agentConfig);
}

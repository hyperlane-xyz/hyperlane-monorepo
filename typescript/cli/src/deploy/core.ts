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
  TestRecipientConfig,
  TestRecipientDeployer,
  buildAgentConfig,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMerge } from '@hyperlane-xyz/utils';

import {
  log,
  logBlue,
  logBoldUnderlinedRed,
  logGray,
  logGreen,
  logRed,
} from '../../logger.js';
import { runDeploymentArtifactStep } from '../config/artifacts.js';
import { presetHookConfigs, readHooksConfigMap } from '../config/hooks.js';
import { readIsmConfig } from '../config/ism.js';
import { readMultisigConfig } from '../config/multisig.js';
import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import {
  getContext,
  getMergedContractAddresses,
  sdkContractAddressesMap,
} from '../context.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import {
  prepNewArtifactsFiles,
  runFileSelectionStep,
  writeJson,
} from '../utils/files.js';

import {
  isISMConfig,
  isZODISMConfig,
  runPreflightChecksForChains,
} from './utils.js';

export async function runCoreDeploy({
  key,
  chainConfigPath,
  chains,
  ismConfigPath,
  hookConfigPath,
  artifactsPath,
  outPath,
  skipConfirmation,
}: {
  key: string;
  chainConfigPath: string;
  chains?: ChainName[];
  ismConfigPath?: string;
  hookConfigPath?: string;
  artifactsPath?: string;
  outPath: string;
  skipConfirmation: boolean;
}) {
  const { customChains, multiProvider, signer } = await getContext({
    chainConfigPath,
    keyConfig: { key },
    skipConfirmation,
  });

  if (!chains?.length) {
    if (skipConfirmation) throw new Error('No chains provided');
    chains = await runMultiChainSelectionStep(
      customChains,
      'Select chains to connect',
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
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    minGas: MINIMUM_CORE_DEPLOY_GAS,
  });
  await executeDeploy(deploymentParams);
}

function runArtifactStep(
  selectedChains: ChainName[],
  skipConfirmation: boolean,
  artifactsPath?: string,
) {
  logBlue(
    '\nDeployments can be totally new or can use some existing contract addresses.',
  );
  return runDeploymentArtifactStep({
    artifactsPath,
    selectedChains,
    skipConfirmation,
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
  chains: string[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  artifacts?: HyperlaneAddressesMap<any>;
  ismConfigs?: ChainMap<IsmConfig>;
  multisigConfigs?: ChainMap<MultisigConfig>;
  hooksConfig?: ChainMap<HooksConfig>;
  outPath: string;
  skipConfirmation: boolean;
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
}: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');

  const [contractsFilePath, agentFilePath] = prepNewArtifactsFiles(outPath, [
    { filename: 'core-deployment', description: 'Contract addresses' },
    { filename: 'agent-config', description: 'Agent configs' },
  ]);

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
    multisigConfigs,
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

  // 5. Deploy TestRecipients to all deployable chains
  log('Deploying test recipient contracts');
  const testRecipientConfig = buildTestRecipientConfigMap(chains, artifacts);
  const testRecipientDeployer = new TestRecipientDeployer(multiProvider);
  testRecipientDeployer.cacheAddressesMap(mergedContractAddrs);
  const testRecipients = await testRecipientDeployer.deploy(
    testRecipientConfig,
  );
  artifacts = writeMergedAddresses(
    contractsFilePath,
    artifacts,
    testRecipients,
  );
  logGreen('Test recipient contracts deployed');

  log('Writing agent configs');
  await writeAgentConfig(agentFilePath, artifacts, chains, multiProvider);
  logGreen('Agent configs written');

  logBlue('Deployment is complete!');
  logBlue(`Contract address artifacts are in ${contractsFilePath}`);
  logBlue(`Agent configs are in ${agentFilePath}`);
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
  multisigConfigs: ChainMap<MultisigConfig>,
): ChainMap<CoreConfig> {
  return chains.reduce<ChainMap<CoreConfig>>((config, chain) => {
    const hooks =
      hooksConfig[chain] ??
      presetHookConfigs(
        owner,
        chain,
        chains.filter((c) => c !== chain),
        multisigConfigs[chain], // if no multisig config, uses default 2/3
      );
    config[chain] = {
      owner,
      defaultIsm: defaultIsms[chain],
      defaultHook: hooks.default,
      requiredHook: hooks.required,
    };
    return config;
  }, {});
}

export function buildTestRecipientConfigMap(
  chains: ChainName[],
  addressesMap: HyperlaneAddressesMap<any>,
): ChainMap<TestRecipientConfig> {
  return chains.reduce<ChainMap<TestRecipientConfig>>((config, chain) => {
    const interchainSecurityModule =
      addressesMap[chain].interchainSecurityModule ??
      ethers.constants.AddressZero;
    if (interchainSecurityModule === ethers.constants.AddressZero) {
      logRed('Error: No ISM for TestRecipient, deploying with zero address');
    }
    config[chain] = { interchainSecurityModule };
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
  for (const chain of chains) {
    const core = HyperlaneCore.fromAddressesMap(artifacts, multiProvider);
    const mailbox = core.getContracts(chain).mailbox;
    startBlocks[chain] = (await mailbox.deployedBlock()).toNumber();
  }
  const mergedAddressesMap = objMerge(
    sdkContractAddressesMap,
    artifacts,
  ) as ChainMap<HyperlaneDeploymentArtifacts>;

  const agentConfig = buildAgentConfig(
    Object.keys(mergedAddressesMap),
    multiProvider,
    mergedAddressesMap,
    startBlocks,
  );
  writeJson(filePath, agentConfig);
}

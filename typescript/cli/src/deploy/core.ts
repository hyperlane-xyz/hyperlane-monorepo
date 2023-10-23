import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  CoreConfig,
  DeployedIsm,
  GasOracleContractType,
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneContractsMap,
  HyperlaneCoreDeployer,
  HyperlaneDeploymentArtifacts,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneIsmFactoryDeployer,
  ModuleType,
  MultiProvider,
  MultisigIsmConfig,
  OverheadIgpConfig,
  RoutingIsmConfig,
  agentStartBlocks,
  buildAgentConfig,
  defaultMultisigIsmConfigs,
  multisigIsmVerificationCost,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMerge } from '@hyperlane-xyz/utils';

import { log, logBlue, logGray, logGreen, logRed } from '../../logger.js';
import { readDeploymentArtifacts } from '../config/artifacts.js';
import { readMultisigConfig } from '../config/multisig.js';
import { MINIMUM_CORE_DEPLOY_BALANCE } from '../consts.js';
import {
  getContextWithSigner,
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
  TestRecipientConfig,
  TestRecipientDeployer,
} from './TestRecipientDeployer.js';
import { runPreflightChecksForChains } from './utils.js';

export async function runCoreDeploy({
  key,
  chainConfigPath,
  chains,
  ismConfigPath,
  artifactsPath,
  outPath,
  skipConfirmation,
}: {
  key: string;
  chainConfigPath: string;
  chains?: ChainName[];
  ismConfigPath?: string;
  artifactsPath?: string;
  outPath: string;
  skipConfirmation: boolean;
}) {
  const { customChains, multiProvider, signer } = getContextWithSigner(
    key,
    chainConfigPath,
  );

  if (!chains?.length) {
    chains = await runMultiChainSelectionStep(
      customChains,
      'Select chains to which core contacts will be deployed',
    );
  }
  const artifacts = await runArtifactStep(chains, artifactsPath);
  const multisigConfig = await runIsmStep(chains, ismConfigPath);

  const deploymentParams: DeployParams = {
    chains,
    signer,
    multiProvider,
    artifacts,
    multisigConfig,
    outPath,
    skipConfirmation,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    minBalanceWei: MINIMUM_CORE_DEPLOY_BALANCE,
  });
  await executeDeploy(deploymentParams);
}

async function runArtifactStep(
  selectedChains: ChainName[],
  artifactsPath?: string,
) {
  if (!artifactsPath) {
    logBlue(
      '\n',
      'Deployments can be totally new or can use some existing contract addresses.',
    );
    const isResume = await confirm({
      message: 'Do you want use some existing contract addresses?',
    });
    if (!isResume) return undefined;

    artifactsPath = await runFileSelectionStep(
      './artifacts',
      'contract artifacts',
      'core-deployment',
    );
  }
  const artifacts = readDeploymentArtifacts(artifactsPath);
  const artifactChains = Object.keys(artifacts).filter((c) =>
    selectedChains.includes(c),
  );
  log(`Found existing artifacts for chains: ${artifactChains.join(', ')}`);
  return artifacts;
}

async function runIsmStep(selectedChains: ChainName[], ismConfigPath?: string) {
  const defaultConfigChains = Object.keys(defaultMultisigIsmConfigs);
  const configRequired = !!selectedChains.find(
    (c) => !defaultConfigChains.includes(c),
  );
  if (!configRequired) return;

  if (!ismConfigPath) {
    logBlue(
      '\n',
      'Hyperlane instances requires an Interchain Security Module (ISM).',
    );
    logGray(
      'Note, only Multisig ISM configs are currently supported in the CLI',
      'Example config: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/cli/typescript/cli/examples/multisig-ism.yaml',
    );
    ismConfigPath = await runFileSelectionStep(
      './configs',
      'ISM config',
      'ism',
    );
  }
  const configs = readMultisigConfig(ismConfigPath);
  const multisigConfigChains = Object.keys(configs).filter((c) =>
    selectedChains.includes(c),
  );
  log(`Found configs for chains: ${multisigConfigChains.join(', ')}`);
  return configs;
}

interface DeployParams {
  chains: string[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  artifacts?: HyperlaneContractsMap<any>;
  multisigConfig?: ChainMap<MultisigIsmConfig>;
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
  const numContracts = Object.keys(
    Object.values(sdkContractAddressesMap)[0],
  ).length;
  log(`There are ${numContracts} contracts for each chain`);
  if (artifacts)
    log('But contracts with an address in the artifacts file will be skipped');
  for (const chain of chains) {
    const chainArtifacts = artifacts?.[chain] || {};
    const numRequired = numContracts - Object.keys(chainArtifacts).length;
    log(`${chain} will require ${numRequired} of ${numContracts}`);
  }
  log('The default interchain security module will be a Multisig.');
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
  multisigConfig = {},
}: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');

  const [contractsFilePath, agentFilePath] = prepNewArtifactsFiles(outPath, [
    { filename: 'core-deployment', description: 'Contract addresses' },
    { filename: 'agent-config', description: 'Agent configs' },
  ]);

  const owner = await signer.getAddress();
  const mergedContractAddrs = getMergedContractAddresses(artifacts);

  // 1. Deploy ISM factories to all deployable chains that don't have them.
  log('Deploying ISM factory contracts');
  const ismFactoryDeployer = new HyperlaneIsmFactoryDeployer(multiProvider);
  ismFactoryDeployer.cacheAddressesMap(mergedContractAddrs);
  const ismFactoryContracts = await ismFactoryDeployer.deploy(chains);
  artifacts = writeMergedAddresses(
    contractsFilePath,
    artifacts,
    ismFactoryContracts,
  );
  logGreen('ISM factory contracts deployed');

  // 2. Deploy IGPs to all deployable chains.
  log('Deploying IGP contracts');
  const igpConfig = buildIgpConfigMap(owner, chains, multisigConfig);
  const igpDeployer = new HyperlaneIgpDeployer(multiProvider);
  igpDeployer.cacheAddressesMap(artifacts);
  const igpContracts = await igpDeployer.deploy(igpConfig);
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, igpContracts);
  logGreen('IGP contracts deployed');

  // Build an IsmFactory that covers all chains so that we can
  // use it to deploy ISMs to remote chains.
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );

  // 3. Deploy ISM contracts to remote deployable chains
  log('Deploying ISMs');
  const ismContracts: ChainMap<{ multisigIsm: DeployedIsm }> = {};
  const defaultIsms: ChainMap<Address> = {};
  for (const ismOrigin of chains) {
    if (artifacts[ismOrigin].multisigIsm) {
      log(`ISM contract recovered, skipping ISM deployment to ${ismOrigin}`);
      defaultIsms[ismOrigin] = artifacts[ismOrigin].multisigIsm;
      continue;
    }
    log(`Deploying ISM to ${ismOrigin}`);
    const ismConfig = buildIsmConfig(
      owner,
      chains.filter((r) => r !== ismOrigin),
      multisigConfig,
    );
    ismContracts[ismOrigin] = {
      multisigIsm: await ismFactory.deploy(ismOrigin, ismConfig),
    };
    defaultIsms[ismOrigin] = ismContracts[ismOrigin].multisigIsm.address;
  }
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, ismContracts);
  logGreen('ISM contracts deployed');

  // 4. Deploy core contracts to chains
  log(`Deploying core contracts to ${chains.join(', ')}`);
  const coreDeployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  coreDeployer.cacheAddressesMap(artifacts);
  const coreConfigs = buildCoreConfigMap(owner, chains, defaultIsms);
  console.log('===coreconfigs', coreConfigs); //TODO remove
  const coreContracts = await coreDeployer.deploy(coreConfigs);
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, coreContracts);
  logGreen('Core contracts deployed');

  // 5. Deploy TestRecipients to all deployable chains
  log('Deploying test recipient contracts');
  const testRecipientConfig = buildTestRecipientConfigMap(chains, artifacts);
  const testRecipientDeployer = new TestRecipientDeployer(multiProvider);
  testRecipientDeployer.cacheAddressesMap(artifacts);
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
  remotes: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): RoutingIsmConfig {
  const mergedMultisigIsmConfig: ChainMap<MultisigIsmConfig> = objMerge(
    defaultMultisigIsmConfigs,
    multisigIsmConfigs,
  );
  return {
    owner,
    type: ModuleType.ROUTING,
    domains: Object.fromEntries(
      remotes.map((remote) => [remote, mergedMultisigIsmConfig[remote]]),
    ),
  };
}

function buildCoreConfigMap(
  owner: Address,
  chains: ChainName[],
  defaultIsms: ChainMap<Address>,
): ChainMap<CoreConfig> {
  return chains.reduce<ChainMap<CoreConfig>>((config, chain) => {
    config[chain] = {
      owner,
      defaultIsm: defaultIsms[chain],
    };
    return config;
  }, {});
}

function buildTestRecipientConfigMap(
  chains: ChainName[],
  addressesMap: HyperlaneAddressesMap<any>,
): ChainMap<TestRecipientConfig> {
  return chains.reduce<ChainMap<TestRecipientConfig>>((config, chain) => {
    const interchainSecurityModule =
      // TODO revisit assumption that multisigIsm is always the ISM
      addressesMap[chain].multisigIsm ??
      addressesMap[chain].interchainSecurityModule ??
      ethers.constants.AddressZero;
    if (interchainSecurityModule === ethers.constants.AddressZero) {
      logRed('Error: No ISM for TestRecipient, deploying with zero address');
    }
    config[chain] = { interchainSecurityModule };
    return config;
  }, {});
}

function buildIgpConfigMap(
  owner: Address,
  chains: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): ChainMap<OverheadIgpConfig> {
  const mergedMultisigIsmConfig: ChainMap<MultisigIsmConfig> = objMerge(
    defaultMultisigIsmConfigs,
    multisigIsmConfigs,
  );
  const configMap: ChainMap<OverheadIgpConfig> = {};
  for (const chain of chains) {
    const overhead: ChainMap<number> = {};
    const gasOracleType: ChainMap<GasOracleContractType> = {};
    for (const remote of chains) {
      if (chain === remote) continue;
      overhead[remote] = multisigIsmVerificationCost(
        mergedMultisigIsmConfig[remote].threshold,
        mergedMultisigIsmConfig[remote].validators.length,
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
  const startBlocks: ChainMap<number> = { ...agentStartBlocks };

  for (const chain of chains) {
    if (startBlocks[chain]) continue;
    startBlocks[chain] = await multiProvider
      .getProvider(chain)
      .getBlockNumber();
  }

  const mergedAddressesMap: HyperlaneAddressesMap<any> = objMerge(
    sdkContractAddressesMap,
    artifacts,
  );
  const filteredAddressesMap = objFilter(
    mergedAddressesMap,
    (chain, v): v is HyperlaneAddresses<any> =>
      chains.includes(chain) &&
      !!v.mailbox &&
      !!v.interchainGasPaymaster &&
      !!v.validatorAnnounce,
  ) as ChainMap<HyperlaneDeploymentArtifacts>;

  // TODO for v3 only build new agent config schema
  const agentConfig = buildAgentConfig(
    Object.keys(filteredAddressesMap),
    multiProvider,
    filteredAddressesMap,
    startBlocks,
  );
  writeJson(filePath, agentConfig);
}

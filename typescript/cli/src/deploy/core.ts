import { Separator, checkbox, confirm, input } from '@inquirer/prompts';
import select from '@inquirer/select';
import chalk from 'chalk';
import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
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
  mainnetChainsMetadata,
  multisigIsmVerificationCost,
  objFilter,
  objMerge,
  serializeContractsMap,
  testnetChainsMetadata,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { readDeploymentArtifacts, readMultisigConfig } from '../configs.js';
import { MINIMUM_CORE_DEPLOY_BALANCE } from '../consts.js';
import { getDeployerContext, sdkContractAddressesMap } from '../context.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
import { prepNewArtifactsFiles, writeJson } from '../utils/files.js';

import {
  TestRecipientConfig,
  TestRecipientDeployer,
} from './TestRecipientDeployer.js';
import { runPreflightChecks } from './utils.js';

export async function runCoreDeploy({
  key,
  configPath,
  outPath,
}: {
  key: string;
  configPath: string;
  outPath: string;
}) {
  const { customChains, multiProvider, signer } = getDeployerContext(
    key,
    configPath,
  );

  const { local, remotes, allChains } = await runChainSelectionStep(
    customChains,
  );
  const artifacts = await runArtifactStep(allChains);
  const multisigConfig = await runIsmStep(allChains);

  const deploymentParams = {
    local,
    remotes,
    signer,
    multiProvider,
    artifacts,
    multisigConfig,
    outPath,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecks({
    ...deploymentParams,
    minBalance: MINIMUM_CORE_DEPLOY_BALANCE,
  });
  await executeDeploy(deploymentParams);
}

async function runChainSelectionStep(customChains: ChainMap<ChainMetadata>) {
  const chainsToChoices = (chains: ChainMetadata[]) =>
    chains.map((c) => ({ name: c.name, value: c.name }));
  const choices: Parameters<typeof select>['0']['choices'] = [
    new Separator('--Custom Chains--'),
    ...chainsToChoices(Object.values(customChains)),
    { name: '(New custom chain)', value: '__new__' },
    new Separator('--Mainnet Chains--'),
    ...chainsToChoices(mainnetChainsMetadata),
    new Separator('--Testnet Chains--'),
    ...chainsToChoices(testnetChainsMetadata),
  ];

  const local = (await select({
    message: 'Select local chain (the chain to which you will deploy now)',
    choices,
    pageSize: 20,
  })) as string;
  handleNewChain([local]);

  const remotes = (await checkbox({
    message: 'Select remote chains the local will send messages to',
    choices,
    pageSize: 20,
  })) as string[];
  handleNewChain(remotes);
  if (!remotes?.length) throw new Error('No remote chains selected');

  const allChains = [local, ...remotes];
  return { local, remotes, allChains };
}

async function runArtifactStep(allChains: ChainName[]) {
  logBlue(
    '\nDeployments can be totally new or can use some existing contract addresses.',
  );
  const isResume = await confirm({
    message: 'Do you want use some existing contract addresses?',
  });
  if (!isResume) return undefined;

  const artifactsPath = await input({
    message: 'Enter filepath with existing contract artifacts (addresses)',
  });
  const artifacts = readDeploymentArtifacts(artifactsPath);
  const artifactChains = Object.keys(artifacts).filter((c) =>
    allChains.includes(c),
  );
  log(`Found existing artifacts for chains: ${artifactChains.join(', ')}`);
  return artifacts;
}

async function runIsmStep(allChains: ChainName[]) {
  logBlue(
    '\nHyperlane instances requires an Interchain Security Module (ISM).',
  );
  const isMultisig = await confirm({
    message: 'Do you want use a Multisig ISM?',
  });
  if (!isMultisig)
    throw new Error(
      'Sorry, only multisig ISMs are currently supported in the CLI',
    );

  const defaultConfigChains = Object.keys(defaultMultisigIsmConfigs);
  const configRequired = !!allChains.find(
    (c) => !defaultConfigChains.includes(c),
  );
  if (!configRequired) return;

  logGray(
    'Example config: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/cli/typescript/cli/examples/multisig-ism.yaml',
  );
  const multisigConfigPath = await input({
    message: 'Enter filepath for the multisig config',
  });
  const configs = readMultisigConfig(multisigConfigPath);
  const multisigConfigChains = Object.keys(configs).filter((c) =>
    allChains.includes(c),
  );
  log(`Found configs for chains: ${multisigConfigChains.join(', ')}`);
  return configs;
}

function handleNewChain(chainNames: string[]) {
  if (chainNames.includes('__new__')) {
    logBlue(
      'To use a new chain, use the --config argument add them to that file',
    );
    log(
      chalk.blue('Use the'),
      chalk.magentaBright('hyperlane config create'),
      chalk.blue('command to create new configs'),
    );
    process.exit(0);
  }
}

interface DeployParams {
  local: string;
  remotes: string[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  artifacts?: HyperlaneContractsMap<any>;
  multiSigConfig?: ChainMap<MultisigIsmConfig>;
  outPath: string;
}

async function runDeployPlanStep({
  local,
  remotes,
  signer,
  artifacts,
}: DeployParams) {
  const address = await signer.getAddress();
  logBlue('\nDeployment plan:');
  logGray('===============:');
  log(`Transaction signer and owner of new contracts will be ${address}`);
  log(`Deploying to ${local} and connecting it to ${remotes.join(', ')}`);
  const numContracts = Object.keys(
    Object.values(sdkContractAddressesMap)[0],
  ).length;
  log(`There are ${numContracts} contracts for each chain`);
  if (artifacts) {
    log('But contracts with an address in the artifacts file will be skipped');
    for (const chain of [local, ...remotes]) {
      const chainArtifacts = artifacts[chain];
      if (!chainArtifacts) continue;
      const numRequired = numContracts - Object.keys(chainArtifacts).length;
      log(`${chain} will require ${numRequired} of ${numContracts}`);
    }
  }
  log('The interchain security module will be a Multisig.');
  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy({
  local,
  remotes,
  signer,
  multiProvider,
  outPath,
  artifacts = {},
  multiSigConfig = {},
}: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');

  const [contractsFilePath, agentFilePath] = prepNewArtifactsFiles(outPath, [
    { filename: 'core-deployment', description: 'Contract addresses' },
    { filename: 'agent-config', description: 'Agent configs' },
  ]);

  const owner = await signer.getAddress();
  const allChains = [local, ...remotes];

  // 1. Deploy ISM factories to all deployable chains that don't have them.
  log('Deploying ISM factory contracts');
  const ismDeployer = new HyperlaneIsmFactoryDeployer(multiProvider);
  ismDeployer.cacheAddressesMap(objMerge(sdkContractAddressesMap, artifacts));
  const ismFactoryContracts = await ismDeployer.deploy(allChains);
  artifacts = writeMergedAddresses(
    contractsFilePath,
    artifacts,
    ismFactoryContracts,
  );
  logGreen(`ISM factory contracts deployed`);

  // 2. Deploy IGPs to all deployable chains.
  log(`Deploying IGP contracts`);
  const igpConfig = buildIgpConfigMap(
    owner,
    allChains,
    allChains,
    multiSigConfig,
  );
  const igpDeployer = new HyperlaneIgpDeployer(multiProvider);
  igpDeployer.cacheAddressesMap(artifacts);
  const igpContracts = await igpDeployer.deploy(igpConfig);
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, igpContracts);
  logGreen(`IGP contracts deployed`);

  // Build an IsmFactory that covers all chains so that we can
  // use it later to deploy ISMs to remote chains.
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    objMerge(sdkContractAddressesMap, artifacts),
    multiProvider,
  );

  // 3. Deploy core contracts to local chain
  log(`Deploying core contracts to ${local}`);
  const coreDeployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  coreDeployer.cacheAddressesMap(artifacts);
  const coreConfig = buildCoreConfigMap(owner, local, remotes, multiSigConfig);
  const coreContracts = await coreDeployer.deploy(coreConfig);
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, coreContracts);
  logGreen(`Core contracts deployed`);

  // 4. Deploy ISM contracts to remote deployable chains
  log(`Deploying ISMs`);
  const ismConfigs = buildIsmConfigMap(
    owner,
    remotes,
    allChains,
    multiSigConfig,
  );
  const ismContracts: ChainMap<{ multisigIsm: DeployedIsm }> = {};
  for (const [ismChain, ismConfig] of Object.entries(ismConfigs)) {
    if (artifacts[ismChain].multisigIsm) {
      log(`ISM contract recovered, skipping ISM deployment to ${ismChain}`);
      continue;
    }
    log(`Deploying ISM to ${ismChain}`);
    ismContracts[ismChain] = {
      multisigIsm: await ismFactory.deploy(ismChain, ismConfig),
    };
  }
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, ismContracts);
  logGreen(`ISM contracts deployed `);

  // 5. Deploy TestRecipients to all deployable chains
  log(`Deploying test recipient contracts`);
  const testRecipientConfig = buildTestRecipientConfigMap(allChains, artifacts);
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
  logGreen(`Test recipient contracts deployed`);

  log('Writing agent configs');
  await writeAgentConfig(
    agentFilePath,
    artifacts,
    local,
    remotes,
    multiProvider,
  );
  logGreen('Agent configs written');

  logBlue('Deployment is complete!');
  logBlue(`Contract address artifacts are in ${contractsFilePath}`);
  logBlue(`Agent configs are in ${agentFilePath}`);
}

function buildIsmConfig(
  owner: types.Address,
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

function buildIsmConfigMap(
  owner: types.Address,
  chains: ChainName[],
  remotes: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): ChainMap<RoutingIsmConfig> {
  return Object.fromEntries(
    chains.map((chain) => {
      const ismConfig = buildIsmConfig(
        owner,
        remotes.filter((r) => r !== chain),
        multisigIsmConfigs,
      );
      return [chain, ismConfig];
    }),
  );
}

function buildCoreConfigMap(
  owner: types.Address,
  local: ChainName,
  remotes: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): ChainMap<CoreConfig> {
  const configMap: ChainMap<CoreConfig> = {};
  configMap[local] = {
    owner,
    defaultIsm: buildIsmConfig(owner, remotes, multisigIsmConfigs),
  };
  return configMap;
}

function buildTestRecipientConfigMap(
  chains: ChainName[],
  addressesMap: HyperlaneAddressesMap<any>,
): ChainMap<TestRecipientConfig> {
  return Object.fromEntries(
    chains.map((chain) => {
      const interchainSecurityModule =
        addressesMap[chain].interchainSecurityModule ??
        ethers.constants.AddressZero;
      return [chain, { interchainSecurityModule }];
    }),
  );
}

function buildIgpConfigMap(
  owner: types.Address,
  deployChains: ChainName[],
  allChains: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): ChainMap<OverheadIgpConfig> {
  const mergedMultisigIsmConfig: ChainMap<MultisigIsmConfig> = objMerge(
    defaultMultisigIsmConfigs,
    multisigIsmConfigs,
  );
  const configMap: ChainMap<OverheadIgpConfig> = {};
  for (const local of deployChains) {
    const overhead: ChainMap<number> = {};
    const gasOracleType: ChainMap<GasOracleContractType> = {};
    for (const remote of allChains) {
      if (local === remote) continue;
      overhead[remote] = multisigIsmVerificationCost(
        mergedMultisigIsmConfig[remote].threshold,
        mergedMultisigIsmConfig[remote].validators.length,
      );
      gasOracleType[remote] = GasOracleContractType.StorageGasOracle;
    }
    configMap[local] = {
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
  local: ChainName,
  remotes: ChainName[],
  multiProvider: MultiProvider,
) {
  const allChains = [local, ...remotes];
  const startBlocks: ChainMap<number> = { ...agentStartBlocks };
  startBlocks[local] = await multiProvider.getProvider(local).getBlockNumber();

  const mergedAddressesMap: HyperlaneAddressesMap<any> = objMerge(
    sdkContractAddressesMap,
    artifacts,
  );
  const filteredAddressesMap = objFilter(
    mergedAddressesMap,
    (chain, v): v is HyperlaneAddresses<any> =>
      allChains.includes(chain) &&
      !!v.mailbox &&
      !!v.interchainGasPaymaster &&
      !!v.validatorAnnounce,
  ) as ChainMap<HyperlaneDeploymentArtifacts>;

  const agentConfig = buildAgentConfig(
    allChains,
    multiProvider,
    filteredAddressesMap,
    startBlocks,
  );
  writeJson(filePath, agentConfig);
}

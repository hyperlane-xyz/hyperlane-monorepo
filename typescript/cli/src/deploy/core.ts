import { Separator, checkbox, confirm, input } from '@inquirer/prompts';
import select from '@inquirer/select';
import { log } from 'console';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

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
  ProtocolType,
  RoutingIsmConfig,
  agentStartBlocks,
  buildAgentConfig,
  defaultMultisigIsmConfigs,
  hyperlaneEnvironments,
  mainnetChainsMetadata,
  multisigIsmVerificationCost,
  objFilter,
  objMerge,
  serializeContractsMap,
  testnetChainsMetadata,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { readChainConfig } from '../chains/config.js';
import { MINIMUM_CORE_DEPLOY_BALANCE } from '../consts.js';
import { logBlue, logGray, logGreen } from '../logger.js';
import { assertBalances } from '../utils/balances.js';
import { readYamlOrJson, writeJson } from '../utils/files.js';
import { assertSigner, keyToSigner } from '../utils/keys.js';
import { getMultiProvider } from '../utils/providers.js';
import { getTimestampForFilename } from '../utils/time.js';

import {
  TestRecipientConfig,
  TestRecipientDeployer,
} from './TestRecipientDeployer.js';

export const sdkContractAddressesMap = {
  ...hyperlaneEnvironments.testnet,
  ...hyperlaneEnvironments.mainnet,
};

export async function runCoreDeploy({
  key,
  configPath,
  outPath,
}: {
  key: string;
  configPath: string;
  outPath: string;
}) {
  const signer = keyToSigner(key);
  const customChains = getCustomChains(configPath);
  const multiProvider = getMultiProvider(customChains, signer);

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
  await runPreflightChecks(deploymentParams);

  const isConfirmed = await confirm({
    message: 'All systems ready, captain. Should we deploy?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
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

function getCustomChains(configPath: string) {
  if (!fs.existsSync(configPath)) {
    log('No config file provided, using default chains in SDK');
    return {};
  } else {
    return readChainConfig(configPath);
  }
}

function handleNewChain(chainNames: string[]) {
  if (chainNames.includes('__new__')) {
    logBlue(
      'To choose a new chain, add them to a config file and use the --config flag',
    );
    logBlue(
      'Use the "hyperlane config create" command to create new chain configs',
    );
    process.exit(0);
  }
}

const GenericDeploymentArtifactsSchema = z
  .object({})
  .catchall(z.object({}).catchall(z.string()));

function readDeploymentArtifacts(filePath: string) {
  const artifacts = readYamlOrJson<HyperlaneContractsMap<any>>(filePath);
  if (!artifacts) throw new Error(`No artifacts found at ${filePath}`);
  const result = GenericDeploymentArtifactsSchema.safeParse(artifacts);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid artifacts: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  return artifacts;
}

function readMultisigConfig(filePath: string) {
  const config = readYamlOrJson<ChainMap<MultisigIsmConfig>>(filePath);
  if (!config) throw new Error(`No multisig config found at ${filePath}`);
  // TODO validate multisig config
  return config;
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
  logBlue('Deployment plan:');
  logGray('===================:');
  log(`Transaction signer and contract owner will be account ${address}`);
  log(
    `Deploying Hyperlane to ${local} and connecting it to ${remotes.join(
      ', ',
    )}`,
  );
  if (artifacts) {
    log('But contracts with an address in the artifacts file will be skipped');
    for (const chain of [local, ...remotes]) {
      const chainArtifacts = artifacts[chain];
      if (!chainArtifacts) continue;
      log(
        `Skipped contracts for ${chain}: ${Object.keys(chainArtifacts).join(
          ', ',
        )}`,
      );
    }
  }
  log(`The interchain security module will be a Multisig.`);
  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function runPreflightChecks({
  local,
  remotes,
  signer,
  multiProvider,
}: DeployParams) {
  log('Running pre-flight checks...');

  if (!local || !remotes?.length) throw new Error('Invalid chain selection');
  if (remotes.includes(local))
    throw new Error('Local and remotes must be distinct');
  for (const chain of [local, ...remotes]) {
    const metadata = multiProvider.tryGetChainMetadata(chain);
    if (!metadata) throw new Error(`No chain config found for ${chain}`);
    if (metadata.protocol !== ProtocolType.Ethereum)
      throw new Error('Only Ethereum chains are supported for now');
  }
  logGreen('Chains are valid ✅');

  assertSigner(signer);
  logGreen('Signer is valid ✅');

  await assertBalances(
    multiProvider,
    signer,
    [local, ...remotes],
    MINIMUM_CORE_DEPLOY_BALANCE,
  );
  logGreen('Balances are sufficient ✅');
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
  const { contractsFilePath, agentFilePath } =
    prepNewArtifactsFilePaths(outPath);

  const owner = await signer.getAddress();
  const allChains = [local, ...remotes];

  // 1. Deploy ISM factories to all deployable chains that don't have them.
  logBlue('Deploying ISM factory contracts');
  const ismDeployer = new HyperlaneIsmFactoryDeployer(multiProvider);
  ismDeployer.cacheAddressesMap(objMerge(sdkContractAddressesMap, artifacts));
  const ismFactoryContracts = await ismDeployer.deploy(allChains);
  console.log(ismFactoryContracts);
  artifacts = writeMergedAddresses(
    contractsFilePath,
    artifacts,
    ismFactoryContracts,
  );
  logBlue(`ISM factory deployment complete`);

  // 2. Deploy IGPs to all deployable chains.
  logBlue(`Deploying IGP contracts`);
  const igpConfig = buildIgpConfigMap(
    owner,
    allChains,
    allChains,
    multiSigConfig,
  );
  const igpDeployer = new HyperlaneIgpDeployer(multiProvider);
  igpDeployer.cacheAddressesMap(artifacts);
  const igpContracts = await igpDeployer.deploy(igpConfig);
  console.log(igpContracts);
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, igpContracts);
  logBlue(`IGP deployment complete`);

  // Build an IsmFactory that covers all chains so that we can
  // use it later to deploy ISMs to remote chains.
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    objMerge(sdkContractAddressesMap, artifacts),
    multiProvider,
  );

  // 3. Deploy core contracts to local chain
  logBlue(`Deploying core contracts to ${local}`);
  const coreDeployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  coreDeployer.cacheAddressesMap(artifacts);
  const coreConfig = buildCoreConfigMap(owner, local, remotes, multiSigConfig);
  const coreContracts = await coreDeployer.deploy(coreConfig);
  console.log(coreContracts);
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, coreContracts);
  logBlue(`Core deployment complete`);

  // 4. Deploy ISM contracts to remote deployable chains
  logBlue(`Deploying ISMs to ${remotes}`);
  const ismConfigs = buildIsmConfigMap(
    owner,
    remotes,
    allChains,
    multiSigConfig,
  );
  const ismContracts: ChainMap<{ interchainSecurityModule: DeployedIsm }> = {};
  for (const [ismChain, ismConfig] of Object.entries(ismConfigs)) {
    logBlue(`Deploying ISM to ${ismChain}`);
    ismContracts[ismChain] = {
      interchainSecurityModule: await ismFactory.deploy(ismChain, ismConfig),
    };
  }
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, ismContracts);
  logBlue(`ISM deployment complete`);

  // 5. Deploy TestRecipients to all deployable chains
  logBlue(`Deploying test recipient contracts`);
  const testRecipientConfig = buildTestRecipientConfigMap(allChains, artifacts);
  const testRecipientDeployer = new TestRecipientDeployer(multiProvider);
  testRecipientDeployer.cacheAddressesMap(artifacts);
  const testRecipients = await testRecipientDeployer.deploy(
    testRecipientConfig,
  );
  console.log(testRecipients);
  artifacts = writeMergedAddresses(
    contractsFilePath,
    artifacts,
    testRecipients,
  );
  logBlue(`Test recipient deployment complete`);

  await writeAgentConfig(
    agentFilePath,
    artifacts,
    local,
    remotes,
    multiProvider,
  );

  logBlue(`Writing agent config to artifacts/agent_config.json`);
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
      oracleKey: 'TODO',
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

function prepNewArtifactsFilePaths(outPath: string) {
  const timestamp = getTimestampForFilename();
  const contractsFilePath = path.join(
    outPath,
    `core-deployment-${timestamp}.json`,
  );
  const agentFilePath = path.join(outPath, `agent-config-${timestamp}.json`);
  // Write an empty object to the file to ensure permissions are okay
  writeJson(contractsFilePath, {});
  logBlue(`Contract address artifacts will be written to ${contractsFilePath}`);
  logBlue(`Agent configs will be written to ${agentFilePath}`);
  return { contractsFilePath, agentFilePath };
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

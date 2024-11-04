import { Account, RpcProvider } from 'starknet';
import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { DeployedCoreAddresses } from '@hyperlane-xyz/sdk';
import {
  ChainMap,
  ChainName,
  ContractVerifier,
  CoreConfig,
  EvmCoreModule,
  ExplorerLicenseType,
  StarknetCoreModule,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { requestAndSaveApiKeys } from '../context/context.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { indentYamlOrJson } from '../utils/files.js';

import {
  completeDeploy,
  prepareDeploy,
  runDeployPlanStep,
  runPreflightChecksForChains,
} from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  chain: ChainName;
  config: CoreConfig;
}

interface ApplyParams extends DeployParams {
  deployedCoreAddresses: DeployedCoreAddresses;
}
/**
 * Executes the core deploy command.
 */
export async function runCoreDeploy(params: DeployParams) {
  const { context, config } = params;
  let chain = params.chain;

  const {
    signer,
    isDryRun,
    chainMetadata,
    dryRunChain,
    registry,
    skipConfirmation,
    multiProvider,
  } = context;

  // Select a dry-run chain if it's not supplied
  if (dryRunChain) {
    chain = dryRunChain;
  } else if (!chain) {
    if (skipConfirmation) throw new Error('No chain provided');
    chain = await runSingleChainSelectionStep(
      chainMetadata,
      'Select chain to connect:',
    );
  }

  if (multiProvider.tryGetProtocol(chain) === ProtocolType.Starknet) {
    const provider = new RpcProvider({
      nodeUrl: 'http://127.0.0.1:5050',
    });
    const account = new Account(
      provider,
      '0x4acc9b79dae485fb71f309f5b62501a1329789f4418bb4c25353ad5617be4d4',
      '0x000000000000000000000000000000002f663fafebbee32e0698f7e13f886c73',
    );
    const starknetCoreModule = new StarknetCoreModule(account);
    const deployments = await starknetCoreModule.deploy();
    console.log(deployments);
    logGreen('✅ Core contract deployments complete:\n');
    return;
  }

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys([chain], chainMetadata, registry);

  const deploymentParams: DeployParams = {
    context,
    chain,
    config,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    chains: [chain],
    minGas: MINIMUM_CORE_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, [chain]);

  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );

  logBlue('🚀 All systems ready, captain! Beginning deployment...');
  const evmCoreModule = await EvmCoreModule.create({
    chain,
    config,
    multiProvider,
    contractVerifier,
  });

  await completeDeploy(context, 'core', initialBalances, userAddress, [chain]);
  const deployedAddresses = evmCoreModule.serialize();

  if (!isDryRun) {
    await registry.updateChain({
      chainName: chain,
      addresses: deployedAddresses,
    });
  }

  logGreen('✅ Core contract deployments complete:\n');
  log(indentYamlOrJson(yamlStringify(deployedAddresses, null, 2), 4));
}

export async function runCoreApply(params: ApplyParams) {
  const { context, chain, deployedCoreAddresses, config } = params;
  const { multiProvider } = context;
  const evmCoreModule = new EvmCoreModule(multiProvider, {
    chain,
    config,
    addresses: deployedCoreAddresses,
  });

  const transactions = await evmCoreModule.update(config);

  if (transactions.length) {
    logGray('Updating deployed core contracts');
    for (const transaction of transactions) {
      await multiProvider.sendTransaction(chain, transaction);
    }

    logGreen(`Core config updated on ${chain}.`);
  } else {
    logGreen(
      `Core config on ${chain} is the same as target. No updates needed.`,
    );
  }
}

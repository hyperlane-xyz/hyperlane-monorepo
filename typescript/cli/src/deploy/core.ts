import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainName,
  ContractVerifier,
  CoreConfig,
  DeployedCoreAddresses,
  EvmCoreModule,
  ExplorerLicenseType,
} from '@hyperlane-xyz/sdk';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { requestAndSaveApiKeys } from '../context/context.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { planFactoryDeployments } from '../utils/deploymentPlan.js';
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
  fix?: boolean;
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
    isDryRun,
    chainMetadata,
    dryRunChain,
    registry,
    skipConfirmation,
    multiProvider,
    fixFactories,
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

  let existingCoreAddresses: ChainAddresses = {};
  let factoryDeploymentPlan: Record<string, boolean> = {};
  if (fixFactories) {
    existingCoreAddresses = (await registry.getChainAddresses(
      chain,
    )) as ChainAddresses;

    // safety check
    if (!existingCoreAddresses.mailbox) {
      throw Error(
        'Mailbox contract not found! Please run `hyperlane core deploy` to deploy core contracts first.',
      );
    }

    factoryDeploymentPlan = planFactoryDeployments(existingCoreAddresses);
  }

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys([chain], chainMetadata, registry);

  const signer = multiProvider.getSigner(chain);

  // Skips confirmations in fix mode for mailbox redeployment prompt
  const deploymentParams: DeployParams = {
    context: fixFactories
      ? { ...context, skipConfirmation: true }
      : { ...context, signer },
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

  let deployedAddresses: ChainAddresses = {};
  if (fixFactories) {
    deployedAddresses = await EvmCoreModule.deployIsmFactories({
      chainName: chain,
      config,
      multiProvider,
      contractVerifier,
      factoryDeploymentPlan,
    });
  } else {
    const evmCoreModule = await EvmCoreModule.create({
      chain,
      config,
      multiProvider,
      contractVerifier,
    } as const);
    deployedAddresses = evmCoreModule.serialize();
  }

  await completeDeploy(context, 'core', initialBalances, userAddress, [chain]);

  const addresses = {
    ...existingCoreAddresses,
    ...deployedAddresses,
  };

  if (!isDryRun) {
    await registry.updateChain({
      chainName: chain,
      addresses,
    });
  }

  logGreen('✅ Core contract deployments complete:\n');
  log(indentYamlOrJson(yamlStringify(addresses, null, 2), 4));
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
      await multiProvider.sendTransaction(
        // Using the provided chain id because there might be remote chain transactions included in the batch
        transaction.chainId ?? chain,
        transaction,
      );
    }

    logGreen(`Core config updated on ${chain}.`);
  } else {
    logGreen(
      `Core config on ${chain} is the same as target. No updates needed.`,
    );
  }
}

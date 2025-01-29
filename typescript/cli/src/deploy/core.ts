import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ChainMap,
  ChainName,
  ContractVerifier,
  CoreConfig,
  DeployedCoreAddresses,
  EvmCoreModule,
  ExplorerLicenseType,
  isIsmCompatible,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

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

  // Validate ISM compatibility
  validateIsmCompatibility(chain, config, context);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys([chain], chainMetadata, registry);

  const signer = multiProvider.getSigner(chain);

  const deploymentParams: DeployParams = {
    context: { ...context, signer },
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

/**
 * Validates that the ISM configuration is compatible with the chain's technical stack.
 * Throws an error if an incompatible ISM type is configured.
 */
function validateIsmCompatibility(
  chain: ChainName,
  config: CoreConfig,
  context: WriteCommandContext,
) {
  const { technicalStack: chainTechnicalStack } =
    context.multiProvider.getChainMetadata(chain);

  if (typeof config.defaultIsm !== 'string') {
    assert(
      isIsmCompatible({
        chainTechnicalStack,
        ismType: config.defaultIsm?.type,
      }),
      `Selected ISM of type ${config.defaultIsm?.type} is not compatible with the selected Chain Technical Stack of ${chainTechnicalStack} for chain ${chain}!`,
    );
  }
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

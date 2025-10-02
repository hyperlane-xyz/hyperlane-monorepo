import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AltVmCoreModule,
  ChainName,
  ContractVerifier,
  CoreConfig,
  DeployedCoreAddresses,
  EvmCoreModule,
  ExplorerLicenseType,
} from '@hyperlane-xyz/sdk';
import { MINIMUM_GAS_ACTION, ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProtocolSignerManager } from '../context/strategies/signer/MultiProtocolSignerManager.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';

import {
  completeDeploy,
  getBalances,
  runDeployPlanStep,
  runPreflightChecksForChains,
  validateCoreIsmCompatibility,
} from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  chain: ChainName;
  config: CoreConfig;
  multiProtocolSigner?: MultiProtocolSignerManager;
}

interface ApplyParams extends DeployParams {
  deployedCoreAddresses: DeployedCoreAddresses;
}

/**
 * Executes the core deploy command.
 */
export async function runCoreDeploy(params: DeployParams) {
  const { context, config } = params;
  const chain = params.chain;
  const { registry, multiProvider, apiKeys } = context;

  // Validate ISM compatibility
  validateCoreIsmCompatibility(chain, config, context);

  const deploymentParams: DeployParams = {
    context: { ...context },
    chain,
    config,
  };

  await runDeployPlanStep(deploymentParams);

  await runPreflightChecksForChains({
    ...deploymentParams,
    chains: [chain],
    minGas: MINIMUM_GAS_ACTION.CORE_DEPLOY_GAS,
  });

  let deployedAddresses: ChainAddresses;
  switch (multiProvider.getProtocol(chain)) {
    case ProtocolType.Ethereum:
      {
        const signer = multiProvider.getSigner(chain);

        const userAddress = await signer.getAddress();

        const initialBalances = await getBalances(
          context,
          [chain],
          userAddress,
        );

        const contractVerifier = new ContractVerifier(
          multiProvider,
          apiKeys!,
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

        await completeDeploy(context, 'core', initialBalances, userAddress, [
          chain,
        ]);
        deployedAddresses = evmCoreModule.serialize();
      }
      break;
    default: {
      const signer = context.altVmSigner.get(chain);

      logBlue('🚀 All systems ready, captain! Beginning deployment...');

      const userAddress = signer.getSignerAddress();
      const initialBalances = await getBalances(context, [chain], userAddress);

      const coreModule = await AltVmCoreModule.create({
        chain,
        config,
        multiProvider,
        signer,
      });

      await completeDeploy(context, 'core', initialBalances, userAddress, [
        chain,
      ]);
      deployedAddresses = coreModule.serialize();
    }
  }

  await registry.updateChain({
    chainName: chain,
    addresses: deployedAddresses,
  });

  logGreen('✅ Core contract deployments complete:\n');
  log(indentYamlOrJson(yamlStringify(deployedAddresses, null, 2), 4));
}

export async function runCoreApply(params: ApplyParams) {
  const { context, chain, deployedCoreAddresses, config } = params;
  const { multiProvider } = context;

  switch (multiProvider.getProtocol(chain)) {
    case ProtocolType.Ethereum: {
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
      break;
    }
    default: {
      const signer = context.altVmSigner.get(chain);

      const coreModule = new AltVmCoreModule(multiProvider, signer, {
        chain,
        config,
        addresses: deployedCoreAddresses,
      });

      const transactions = await coreModule.update(config);

      if (transactions.length) {
        logGray('Updating deployed core contracts');

        await signer.signAndBroadcast(transactions.map((t) => t.transaction));

        logGreen(`Core config updated on ${chain}.`);
      } else {
        logGreen(
          `Core config on ${chain} is the same as target. No updates needed.`,
        );
      }
    }
  }
}

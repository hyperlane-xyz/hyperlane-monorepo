import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { AltVMCoreModule } from '@hyperlane-xyz/deploy-sdk';
import { GasAction, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainName,
  type ChainMap,
  ContractVerifier,
  type CoreConfig,
  type DeployedCoreAddresses,
  EvmCoreModule,
  ExplorerLicenseType,
  altVmChainLookup,
} from '@hyperlane-xyz/sdk';
import { mustGet } from '@hyperlane-xyz/utils';

import { type MultiProtocolSignerManager } from '../context/strategies/signer/MultiProtocolSignerManager.js';
import { type WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
import { resolveSubmitterBatchesForTransactions } from '../submitters/inference.js';
import { indentYamlOrJson } from '../utils/files.js';

import { validateCoreConfigForAltVM } from './configValidation.js';
import {
  completeDeploy,
  getBalances,
  runDeployPlanStep,
  runPreflightChecksForChains,
  validateCoreIsmCompatibility,
} from './utils.js';
import { getSubmitterByConfig, getSubmitterByStrategy } from './warp.js';

interface DeployParams {
  context: WriteCommandContext;
  chain: ChainName;
  config: CoreConfig;
  multiProtocolSigner?: MultiProtocolSignerManager;
}

interface ApplyParams extends DeployParams {
  deployedCoreAddresses: DeployedCoreAddresses;
  strategyUrl?: string;
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
    minGas: GasAction.CORE_DEPLOY_GAS,
  });

  let deployedAddresses: ChainAddresses;
  const protocol = multiProvider.getProtocol(chain);
  switch (protocol) {
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
      const signer = mustGet(context.altVmSigners, chain);
      logBlue('🚀 All systems ready, captain! Beginning deployment...');

      const userAddress = signer.getSignerAddress();
      const initialBalances = await getBalances(context, [chain], userAddress);

      const coreModule = await AltVMCoreModule.create({
        chain,
        config: validateCoreConfigForAltVM(config, chain),
        chainLookup: altVmChainLookup(multiProvider),
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

  const protocol = multiProvider.getProtocol(chain);
  switch (protocol) {
    case ProtocolType.Ethereum: {
      const evmCoreModule = new EvmCoreModule(multiProvider, {
        chain,
        config,
        addresses: deployedCoreAddresses,
      });

      const transactions = await evmCoreModule.update(config);

      if (transactions.length) {
        logGray('Updating deployed core contracts');
        const transactionsByChain: ChainMap<typeof transactions> = {};
        for (const transaction of transactions) {
          const transactionChain = multiProvider.getChainName(
            transaction.chainId ?? chain,
          );
          transactionsByChain[transactionChain] ??= [];
          transactionsByChain[transactionChain].push(transaction);
        }

        for (const [transactionChain, chainTransactions] of Object.entries(
          transactionsByChain,
        )) {
          const submitterBatches = await resolveSubmitterBatchesForTransactions({
            chain: transactionChain,
            transactions: chainTransactions as any[],
            context,
            strategyUrl: params.strategyUrl,
          });

          for (const batch of submitterBatches) {
            const { submitter } = await getSubmitterByConfig({
              chain: transactionChain,
              context,
              submissionStrategy: batch.config,
            });
            logGray(
              `Submitting ${batch.transactions.length} core update transaction(s) on ${transactionChain} with submitter ${submitter.txSubmitterType}`,
            );
            await submitter.submit(...(batch.transactions as any[]));
          }
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
      const signer = mustGet(context.altVmSigners, chain);

      const { submitter } = await getSubmitterByStrategy({
        chain,
        context: params.context,
        strategyUrl: params.strategyUrl,
      });

      const validatedConfig = validateCoreConfigForAltVM(config, chain);

      const coreModule = new AltVMCoreModule(
        altVmChainLookup(multiProvider),
        signer,
        {
          chain,
          config: validatedConfig,
          addresses: deployedCoreAddresses,
        },
      );

      const transactions = await coreModule.update(validatedConfig);

      if (transactions.length) {
        logGray('Updating deployed core contracts');
        logGray(
          `Submitting ${transactions.length} core update transaction(s) on ${chain} with submitter ${submitter.txSubmitterType}`,
        );

        await submitter.submit(...transactions);

        logGreen(`Core config updated on ${chain}.`);
      } else {
        logGreen(
          `Core config on ${chain} is the same as target. No updates needed.`,
        );
      }
    }
  }
}

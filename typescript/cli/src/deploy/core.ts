import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainName,
  ContractVerifier,
  CoreConfig,
  CosmosNativeCoreModule,
  DeployedCoreAddresses,
  EvmCoreModule,
  ExplorerLicenseType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { MultiProtocolSignerManager } from '../context/strategies/signer/MultiProtocolSignerManager.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
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
  const { isDryRun, registry, multiProvider, multiProtocolSigner, apiKeys } =
    context as any;

  const deploymentParams: DeployParams = {
    context: { ...context },
    chain,
    config,
  };

  let deployedAddresses: ChainAddresses;
  switch (multiProvider.getProtocol(chain)) {
    case ProtocolType.Ethereum:
      {
        const signer = multiProvider.getSigner(chain);
        await runDeployPlanStep(deploymentParams);

        await runPreflightChecksForChains({
          ...deploymentParams,
          chains: [chain],
          minGas: MINIMUM_CORE_DEPLOY_GAS,
        });

        const userAddress = await signer.getAddress();

        const initialBalances = await prepareDeploy(context, userAddress, [
          chain,
        ]);

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

        await completeDeploy(context, 'core', initialBalances, userAddress, [
          chain,
        ]);
        deployedAddresses = evmCoreModule.serialize();
      }
      break;

    case ProtocolType.CosmosNative:
      {
        await multiProtocolSigner?.initSigner(chain);
        const signer =
          multiProtocolSigner?.getCosmosNativeSigner(chain) ?? null;
        assert(signer, 'Cosmos Native signer failed!');

        logBlue('🚀 All systems ready, captain! Beginning deployment...');

        const cosmosNativeCoreModule = await CosmosNativeCoreModule.create({
          chain,
          config,
          multiProvider,
          signer,
        });

        deployedAddresses = cosmosNativeCoreModule.serialize();
      }
      break;

    default:
      throw new Error('Chain protocol is not supported yet!');
  }

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
  const { multiProvider, multiProtocolSigner } = context;

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
    case ProtocolType.CosmosNative: {
      await multiProtocolSigner?.initSigner(chain);
      const signer = multiProtocolSigner?.getCosmosNativeSigner(chain) ?? null;
      assert(signer, 'Cosmos Native signer failed!');

      const cosmosNativeCoreModule = new CosmosNativeCoreModule(
        multiProvider,
        signer,
        {
          chain,
          config,
          addresses: deployedCoreAddresses,
        },
      );

      const transactions = await cosmosNativeCoreModule.update(config);

      if (transactions.length) {
        logGray('Updating deployed core contracts');
        const response = await signer.signAndBroadcast(
          signer.account.address,
          transactions,
          2,
        );

        assert(
          response.code === 0,
          `Transaction failed with status code ${response.code}`,
        );

        logGreen(`Core config updated on ${chain}.`);
      } else {
        logGreen(
          `Core config on ${chain} is the same as target. No updates needed.`,
        );
      }
      break;
    }
  }
}

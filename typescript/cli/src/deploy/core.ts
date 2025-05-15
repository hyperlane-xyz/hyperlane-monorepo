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
  StarknetCoreModule,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { requestAndSaveApiKeys } from '../context/context.js';
import { MultiProtocolSignerManager } from '../context/strategies/signer/MultiProtocolSignerManager.js';
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
  multiProtocolSigner?: MultiProtocolSignerManager;
}

interface ApplyParams extends DeployParams {
  deployedCoreAddresses: DeployedCoreAddresses;
}

/**
 * Executes the core deploy command.
 */
export async function runCoreDeploy(params: DeployParams) {
  const { context, config, multiProtocolSigner } = params;
  let chain = params.chain;
  const {
    isDryRun,
    chainMetadata,
    dryRunChain,
    registry,
    skipConfirmation,
    multiProvider,
    multiProtocolProvider,
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
  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys([chain], chainMetadata, registry);

  const deploymentParams: DeployParams = {
    context,
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

    case ProtocolType.Starknet:
      {
        const account = multiProtocolSigner!.getStarknetSigner(chain);
        assert(account, 'Starknet account failed!');
        const starknetCoreModule = new StarknetCoreModule(
          account,
          multiProtocolProvider!,
          chain,
        );
        deployedAddresses = await starknetCoreModule.deploy({
          chain,
          config,
        });
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
  const { multiProvider, multiProtocolSigner, multiProtocolProvider } = context;

  const protocol = multiProvider.getProtocol(chain);

  let transactions: any[] = [];
  let module: EvmCoreModule | StarknetCoreModule;

  if (protocol === ProtocolType.Starknet) {
    const account = multiProtocolSigner!.getStarknetSigner(chain);
    assert(account, 'Starknet account failed!');
    module = new StarknetCoreModule(account, multiProtocolProvider!, chain, {
      addresses: deployedCoreAddresses,
      config,
      chain,
    });

    transactions = await module.update(config);

    if (transactions.length) {
      logGray('Updating deployed core contracts');
      for (const transaction of transactions as any[]) {
        // Cast to any[] to match starknet transaction structure
        const tx = await account.execute([
          {
            contractAddress: transaction.contractAddress,
            calldata: transaction.calldata,
            entrypoint: transaction.entrypoint!,
          },
        ]);
        await account.waitForTransaction(tx.transaction_hash);
      }
    }
  } else {
    module = new EvmCoreModule(multiProvider, {
      chain,
      config,
      addresses: deployedCoreAddresses,
    });

    transactions = await module.update(config);

    if (transactions.length) {
      logGray('Updating deployed core contracts');
      for (const transaction of transactions) {
        await multiProvider.sendTransaction(
          // Using the provided chain id because there might be remote chain transactions included in the batch
          transaction.chainId ?? chain,
          transaction,
        );
      }
    }
  }

  if (transactions.length) {
    logGreen(`Core config updated on ${chain}.`);
  } else {
    logGreen(
      `Core config on ${chain} is the same as target. No updates needed.`,
    );
  }
}

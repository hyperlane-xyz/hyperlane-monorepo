import { Logger } from 'pino';
import { Abi, encodeFunctionData } from 'viem';

import {
  Address,
  EvmChainId,
  deepCopy,
  eqAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { CCIPContractCache } from '../ccip/utils.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { HypTokenRouterConfig } from '../token/types.js';
import { ChainName } from '../types.js';
import { extractIsmAndHookFactoryAddresses } from '../utils/ism.js';

import { EvmHookModule } from './EvmHookModule.js';
import { DerivedHookConfig } from './types.js';

type ReadOnlyDerivedHookConfig = Readonly<DerivedHookConfig>;
type ReadOnlyHookConfig = Readonly<NonNullable<HypTokenRouterConfig['hook']>>;

type UpdateHookParams = {
  evmChainId: EvmChainId;
  evmChainName: ChainName;
  mailbox: string;
  proxyAdminAddress: string;
  expectedConfig: ReadOnlyHookConfig;
  actualConfig: ReadOnlyDerivedHookConfig | string;
  logger: Logger;
  hookAndIsmFactories: ReturnType<typeof extractIsmAndHookFactoryAddresses>;
  multiProvider: MultiProvider;
  setHookFunctionName: string;
  contractToCallAbi: Abi;
  ccipContractCache?: CCIPContractCache;
  contractVerifier?: ContractVerifier;
};

export async function getEvmHookUpdateTransactions(
  clientContractAddress: string,
  updateHookParams: UpdateHookParams,
): Promise<AnnotatedEV5Transaction[]> {
  const updateTransactions: AnnotatedEV5Transaction[] = [];

  const { expectedConfig: expectedHookConfig, actualConfig: actualHookConfig } =
    updateHookParams;

  if (
    typeof expectedHookConfig === 'string' &&
    isZeroishAddress(expectedHookConfig)
  ) {
    return [];
  }

  // Try to deploy or update Hook with the expected config
  const {
    deployedHook: expectedDeployedHook,
    updateTransactions: hookUpdateTransactions,
  } = await deployOrUpdateHook(updateHookParams);

  // If a Hook is updated in-place, push the update txs
  updateTransactions.push(...hookUpdateTransactions);

  // If a new Hook is deployed, push the setHook tx
  if (
    !eqAddress(
      typeof actualHookConfig === 'string'
        ? actualHookConfig
        : actualHookConfig.address,
      expectedDeployedHook,
    )
  ) {
    updateTransactions.push({
      chainId: updateHookParams.evmChainId,
      annotation: `Setting Hook for Warp Route to ${expectedDeployedHook}`,
      to: clientContractAddress,
      data: encodeFunctionData({
        abi: updateHookParams.contractToCallAbi,
        functionName: updateHookParams.setHookFunctionName,
        args: [expectedDeployedHook],
      }),
    });
  }

  return updateTransactions;
}

/**
 * Updates or deploys the hook using the provided configuration.
 *
 * @returns Object with deployedHook address, and update Transactions
 */
async function deployOrUpdateHook(updateHookParams: UpdateHookParams): Promise<{
  deployedHook: Address;
  updateTransactions: AnnotatedEV5Transaction[];
}> {
  if (
    typeof updateHookParams.actualConfig === 'string' &&
    isZeroishAddress(updateHookParams.actualConfig)
  ) {
    return deployNewHook(updateHookParams);
  }

  return updateExistingHook(updateHookParams);
}

async function deployNewHook({
  evmChainId,
  evmChainName,
  mailbox,
  proxyAdminAddress,
  expectedConfig,
  logger,
  hookAndIsmFactories,
  multiProvider,
  ccipContractCache,
  contractVerifier,
}: UpdateHookParams): Promise<{
  deployedHook: Address;
  updateTransactions: AnnotatedEV5Transaction[];
}> {
  logger.info(
    `No hook deployed for warp route, deploying new hook on ${evmChainName} chain`,
  );

  const hookModule = await EvmHookModule.create({
    chain: evmChainName,
    config: deepCopy(expectedConfig),
    proxyFactoryFactories: hookAndIsmFactories,
    coreAddresses: {
      mailbox: mailbox,
      proxyAdmin: proxyAdminAddress, // Assume that a proxyAdmin is always deployed with a WarpRoute
    },
    ccipContractCache,
    contractVerifier,
    multiProvider,
  });
  const { deployedHook } = hookModule.serialize();
  return { deployedHook, updateTransactions: [] };
}

async function updateExistingHook({
  evmChainName,
  mailbox,
  proxyAdminAddress,
  expectedConfig,
  logger,
  actualConfig,
  hookAndIsmFactories,
  multiProvider,
  ccipContractCache,
  contractVerifier,
}: UpdateHookParams): Promise<{
  deployedHook: Address;
  updateTransactions: AnnotatedEV5Transaction[];
}> {
  const hookModule = new EvmHookModule(
    multiProvider,
    {
      chain: evmChainName,
      config: actualConfig,
      addresses: {
        ...hookAndIsmFactories,
        mailbox,
        proxyAdmin: proxyAdminAddress,
        deployedHook:
          typeof actualConfig === 'string'
            ? actualConfig
            : actualConfig.address,
      },
    },
    ccipContractCache,
    contractVerifier,
  );

  logger.info(`Comparing target Hook config with ${evmChainName} chain`);
  const updateTransactions = await hookModule.update(deepCopy(expectedConfig));
  const { deployedHook } = hookModule.serialize();

  return { deployedHook, updateTransactions };
}

import { type Logger } from 'pino';

import { type Address, deepCopy, eqAddress } from '@hyperlane-xyz/utils';

import { type CCIPContractCache } from '../ccip/utils.js';
import { type ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { type MultiProvider } from '../providers/MultiProvider.js';
import { type AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { type HypTokenRouterConfig } from '../token/types.js';
import { type ChainName } from '../types.js';
import { type extractIsmAndHookFactoryAddresses } from '../utils/ism.js';

import { EvmHookModule } from './EvmHookModule.js';
import { type DerivedHookConfig } from './types.js';

type ReadOnlyDerivedHookConfig = Readonly<DerivedHookConfig>;
type ReadOnlyHookConfig = Readonly<NonNullable<HypTokenRouterConfig['hook']>>;

type UpdateHookParams = {
  evmChainName: ChainName;
  mailbox: string;
  proxyAdminAddress: string;
  expectedConfig: ReadOnlyHookConfig;
  actualConfig: ReadOnlyDerivedHookConfig | string;
  logger: Logger;
  hookAndIsmFactories: ReturnType<typeof extractIsmAndHookFactoryAddresses>;
  multiProvider: MultiProvider;
  setHookFunctionCallEncoder: (newHookAddress: Address) => string;
  ccipContractCache?: CCIPContractCache;
  contractVerifier?: ContractVerifier;
};

export async function getEvmHookUpdateTransactions(
  clientContractAddress: string,
  updateHookParams: Readonly<UpdateHookParams>,
): Promise<AnnotatedEV5Transaction[]> {
  const {
    actualConfig: actualHookConfig,
    evmChainName,
    mailbox,
    proxyAdminAddress,
    expectedConfig,
    logger,
    hookAndIsmFactories,
    multiProvider,
    ccipContractCache,
    contractVerifier,
  } = updateHookParams;

  const hookModule = new EvmHookModule(
    multiProvider,
    {
      chain: evmChainName,
      config: actualHookConfig,
      addresses: {
        ...hookAndIsmFactories,
        mailbox,
        proxyAdmin: proxyAdminAddress,
        deployedHook:
          typeof actualHookConfig === 'string'
            ? actualHookConfig
            : actualHookConfig.address,
      },
    },
    ccipContractCache,
    contractVerifier,
  );

  // Get the current hook address before applying the txs to identify if
  // a new hook was deployed during the update process
  const { deployedHook: currentHookAddress } = hookModule.serialize();

  logger.info(
    `Comparing target Hook config with current one for ${evmChainName} chain`,
  );
  const updateTransactions = await hookModule.update(deepCopy(expectedConfig));
  const { deployedHook: newHookAddress } = hookModule.serialize();

  // If a new Hook is deployed, push the tx to set the hook on the client contract
  if (!eqAddress(currentHookAddress, newHookAddress)) {
    updateTransactions.push({
      chainId: updateHookParams.multiProvider.getEvmChainId(
        updateHookParams.evmChainName,
      ),
      annotation: `Setting Hook ${newHookAddress} for contract at ${clientContractAddress} on chain ${evmChainName}`,
      to: clientContractAddress,
      data: updateHookParams.setHookFunctionCallEncoder(newHookAddress),
    });
  }

  return updateTransactions;
}

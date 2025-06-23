import { IRegistry } from '@hyperlane-xyz/registry';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../MultiProvider.js';

import { EvmIcaTxSubmitter } from './IcaTxSubmitter.js';
import { TxSubmitterInterface } from './TxSubmitterInterface.js';
import { TxSubmitterType } from './TxSubmitterTypes.js';
import { TxSubmitterBuilder } from './builder/TxSubmitterBuilder.js';
import { SubmissionStrategy } from './builder/types.js';
import { EV5GnosisSafeTxBuilder } from './ethersV5/EV5GnosisSafeTxBuilder.js';
import { EV5GnosisSafeTxSubmitter } from './ethersV5/EV5GnosisSafeTxSubmitter.js';
import { EV5ImpersonatedAccountTxSubmitter } from './ethersV5/EV5ImpersonatedAccountTxSubmitter.js';
import { EV5JsonRpcTxSubmitter } from './ethersV5/EV5JsonRpcTxSubmitter.js';
import { SubmitterMetadata } from './types.js';

export type SubmitterBuilderSettings = {
  submissionStrategy: SubmissionStrategy;
  multiProvider: MultiProvider;
  registry: IRegistry;
};

export async function getSubmitterBuilder<TProtocol extends ProtocolType>({
  submissionStrategy,
  multiProvider,
  registry,
}: SubmitterBuilderSettings): Promise<TxSubmitterBuilder<TProtocol>> {
  const submitter = await getSubmitter<TProtocol>(
    multiProvider,
    submissionStrategy.submitter,
    registry,
  );

  return new TxSubmitterBuilder<TProtocol>(submitter);
}

export async function getSubmitter<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  submitterMetadata: SubmitterMetadata,
  registry: IRegistry,
): Promise<TxSubmitterInterface<TProtocol>> {
  let interchainAccountRouterAddress: Address | undefined;
  if (submitterMetadata.type === TxSubmitterType.INTERCHAIN_ACCOUNT) {
    const metadata = await registry.getChainAddresses(submitterMetadata.chain);

    interchainAccountRouterAddress =
      submitterMetadata.originInterchainAccountRouter ??
      metadata?.interchainAccountRouter;
  }

  switch (submitterMetadata.type) {
    case TxSubmitterType.JSON_RPC:
      return new EV5JsonRpcTxSubmitter(multiProvider, {
        ...submitterMetadata,
      });
    case TxSubmitterType.IMPERSONATED_ACCOUNT:
      return new EV5ImpersonatedAccountTxSubmitter(multiProvider, {
        ...submitterMetadata,
      });
    case TxSubmitterType.GNOSIS_SAFE:
      return EV5GnosisSafeTxSubmitter.create(multiProvider, {
        ...submitterMetadata,
      });
    case TxSubmitterType.GNOSIS_TX_BUILDER:
      return EV5GnosisSafeTxBuilder.create(multiProvider, {
        ...submitterMetadata,
      });
    case TxSubmitterType.INTERCHAIN_ACCOUNT:
      if (!interchainAccountRouterAddress) {
        throw new Error(
          `Origin chain InterchainAccountRouter address not supplied and none found in the registry metadata for chain ${submitterMetadata.chain}`,
        );
      }

      return EvmIcaTxSubmitter.fromConfig(
        {
          ...submitterMetadata,
          originInterchainAccountRouter: interchainAccountRouterAddress,
        },
        multiProvider,
        registry,
      );
    default:
      throw new Error(`Invalid TxSubmitterType.`);
  }
}

import {
  EV5GnosisSafeTxBuilder,
  EV5GnosisSafeTxSubmitter,
  EV5ImpersonatedAccountTxSubmitter,
  EV5InterchainAccountTxTransformer,
  EV5JsonRpcTxSubmitter,
  MultiProvider,
  SubmitterMetadata,
  TransformerMetadata,
  TxSubmitterBuilder,
  TxSubmitterInterface,
  TxSubmitterType,
  TxTransformerInterface,
  TxTransformerType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { SubmitterBuilderSettings } from './types.js';

export async function getSubmitterBuilder<TProtocol extends ProtocolType>({
  submissionStrategy,
  multiProvider,
}: SubmitterBuilderSettings): Promise<TxSubmitterBuilder<TProtocol>> {
  const submitter = await getSubmitter<TProtocol>(
    multiProvider,
    submissionStrategy.submitter,
  );
  const transformers =
    submissionStrategy.transforms?.map((t) =>
      getTransformer<TProtocol>(multiProvider, t),
    ) ?? [];

  return new TxSubmitterBuilder<TProtocol>(submitter, transformers);
}

async function getSubmitter<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  submitterMetadata: SubmitterMetadata,
): Promise<TxSubmitterInterface<TProtocol>> {
  switch (submitterMetadata.type) {
    case TxSubmitterType.JSON_RPC:
      return new EV5JsonRpcTxSubmitter(multiProvider, submitterMetadata);
    case TxSubmitterType.IMPERSONATED_ACCOUNT:
      return new EV5ImpersonatedAccountTxSubmitter(
        multiProvider,
        submitterMetadata,
      );
    case TxSubmitterType.GNOSIS_SAFE:
      return EV5GnosisSafeTxSubmitter.create(multiProvider, submitterMetadata);
    case TxSubmitterType.GNOSIS_TX_BUILDER:
      return EV5GnosisSafeTxBuilder.create(multiProvider, submitterMetadata);
    default:
      throw new Error(`Invalid TxSubmitterType.`);
  }
}

function getTransformer<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  transformerMetadata: TransformerMetadata,
): TxTransformerInterface<TProtocol> {
  switch (transformerMetadata.type) {
    case TxTransformerType.INTERCHAIN_ACCOUNT:
      return new EV5InterchainAccountTxTransformer(
        multiProvider,
        transformerMetadata,
      );
    default:
      throw new Error('Invalid TxTransformerType.');
  }
}

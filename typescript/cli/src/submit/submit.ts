import {
  EV5GnosisSafeTxSubmitter,
  EV5GnosisSafeTxSubmitterProps,
  EV5ImpersonatedAccountTxSubmitter,
  EV5ImpersonatedAccountTxSubmitterProps,
  EV5InterchainAccountTxTransformer,
  EV5JsonRpcTxSubmitter,
  MultiProvider,
  TxSubmitterBuilder,
  TxSubmitterInterface,
  TxSubmitterType,
  TxTransformerInterface,
  TxTransformerType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  SubmitterBuilderSettings,
  SubmitterMetadata,
  TransformerMetadata,
} from './types.js';

export async function getSubmitterBuilder<TProtocol extends ProtocolType>({
  submitterMetadata,
  transformersMetadata,
  multiProvider,
}: SubmitterBuilderSettings): Promise<TxSubmitterBuilder<TProtocol>> {
  const submitter = await getSubmitter<TProtocol>(
    multiProvider,
    submitterMetadata,
  );
  const transformers = await getTransformers<TProtocol>(
    multiProvider,
    transformersMetadata,
  );

  return new TxSubmitterBuilder<TProtocol>(submitter, transformers);
}

async function getSubmitter<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  submitterMetadata: SubmitterMetadata,
): Promise<TxSubmitterInterface<TProtocol>> {
  switch (submitterMetadata.type) {
    case TxSubmitterType.JSON_RPC:
      return new EV5JsonRpcTxSubmitter(multiProvider);
    case TxSubmitterType.IMPERSONATED_ACCOUNT:
      return new EV5ImpersonatedAccountTxSubmitter(
        multiProvider,
        submitterMetadata.props as EV5ImpersonatedAccountTxSubmitterProps,
      );
    case TxSubmitterType.GNOSIS_SAFE:
      return new EV5GnosisSafeTxSubmitter(
        multiProvider,
        submitterMetadata.props as EV5GnosisSafeTxSubmitterProps,
      );
    default:
      throw new Error(`Invalid TxSubmitterType: ${submitterMetadata.type}`);
  }
}

async function getTransformers<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  metadata: TransformerMetadata[],
): Promise<TxTransformerInterface<TProtocol>[]> {
  return Promise.all(
    metadata.map(({ type, props: settings }) =>
      getTransformer<TProtocol>(multiProvider, { type, props: settings }),
    ),
  );
}

async function getTransformer<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  transformerMetadata: TransformerMetadata,
): Promise<TxTransformerInterface<TProtocol>> {
  switch (transformerMetadata.type) {
    case TxTransformerType.INTERCHAIN_ACCOUNT:
      return new EV5InterchainAccountTxTransformer(
        multiProvider,
        transformerMetadata.props,
      );
    default:
      throw new Error(`Invalid TxTransformerType: ${transformerMetadata.type}`);
  }
}

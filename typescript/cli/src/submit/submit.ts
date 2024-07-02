import {
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
  submitterMetadata,
  transformersMetadata,
  multiProvider,
  isDryRun = false,
}: SubmitterBuilderSettings): Promise<TxSubmitterBuilder<TProtocol>> {
  const submitter = await getSubmitter<TProtocol>(
    multiProvider,
    submitterMetadata,
    isDryRun,
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
  isDryRun = false,
): Promise<TxSubmitterInterface<TProtocol>> {
  switch (submitterMetadata.type) {
    case TxSubmitterType.JSON_RPC:
      return new EV5JsonRpcTxSubmitter(multiProvider);
    case TxSubmitterType.IMPERSONATED_ACCOUNT:
      if (!isDryRun)
        throw new Error(
          'Impersonated account submitters may only be used during dry-runs.',
        );
      return new EV5ImpersonatedAccountTxSubmitter(
        multiProvider,
        submitterMetadata,
      );
    case TxSubmitterType.GNOSIS_SAFE:
      return new EV5GnosisSafeTxSubmitter(multiProvider, submitterMetadata);
    default:
      throw new Error(`Invalid TxSubmitterType.`);
  }
}

async function getTransformers<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  transformersMetadata: TransformerMetadata[],
): Promise<TxTransformerInterface<TProtocol>[]> {
  return Promise.all(
    transformersMetadata.map(({ type, props }) =>
      getTransformer<TProtocol>(multiProvider, { type, props }),
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
      throw new Error(`Invalid TxTransformerType.`);
  }
}

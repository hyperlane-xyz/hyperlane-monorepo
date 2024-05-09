import {
  EV5GnosisSafeTxSubmitter,
  EV5ImpersonatedAccountTxSubmitter,
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

import { forkNetworkToMultiProvider, verifyAnvil } from '../deploy/dry-run.js';

import {
  SubmitterBuilderSettings,
  SubmitterMetadata,
  TransformerMetadata,
} from './submitTypes.js';

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
  { type, settings }: SubmitterMetadata,
): Promise<TxSubmitterInterface<TProtocol>> {
  switch (type) {
    case TxSubmitterType.JSON_RPC:
      return new EV5JsonRpcTxSubmitter(multiProvider);
    case TxSubmitterType.IMPERSONATED_ACCOUNT:
      if (!settings)
        throw new Error(
          'Must provide EV5ImpersonatedAccountTxSubmitterProps for impersonated account submitter.',
        );

      await verifyAnvil();
      await forkNetworkToMultiProvider(
        multiProvider,
        settings.eV5ImpersonatedAccountProps.chain,
      );

      return new EV5ImpersonatedAccountTxSubmitter(
        multiProvider,
        settings.eV5ImpersonatedAccountProps,
      );
    case TxSubmitterType.GNOSIS_SAFE:
      if (!settings)
        throw new Error(
          'Must provide EV5GnosisSafeTxSubmitterProps for Gnosis safe submitter.',
        );
      return new EV5GnosisSafeTxSubmitter(
        multiProvider,
        settings.eV5GnosisSafeProps,
      );
    default:
      throw new Error(`Invalid TxSubmitterType: ${type}`);
  }
}

async function getTransformers<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  metadata: TransformerMetadata[],
): Promise<TxTransformerInterface<TProtocol>[]> {
  return Promise.all(
    metadata.map(({ type, settings }) =>
      getTransformer<TProtocol>(multiProvider, { type, settings }),
    ),
  );
}

async function getTransformer<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  { type, settings }: TransformerMetadata,
): Promise<TxTransformerInterface<TProtocol>> {
  switch (type) {
    case TxTransformerType.ICA:
      if (!settings)
        throw new Error(
          'Must provide EV5InterchainAccountTxTransformerProps for ICA transformer.',
        );
      return new EV5InterchainAccountTxTransformer(
        multiProvider,
        settings.eV5InterchainAccountProps,
      );
    default:
      throw new Error(`Invalid TxTransformerType: ${type}`);
  }
}

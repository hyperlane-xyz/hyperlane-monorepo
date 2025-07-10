import { IRegistry } from '@hyperlane-xyz/registry';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

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

type SubmitterFactory<TProtocol extends ProtocolType = any> = (
  multiProvider: MultiProvider,
  metadata: SubmitterMetadata,
  registry: IRegistry,
) => Promise<TxSubmitterInterface<TProtocol>> | TxSubmitterInterface<TProtocol>;

const submitterRegistry: Record<string, SubmitterFactory> = {
  [TxSubmitterType.JSON_RPC]: (multiProvider, metadata) => {
    // Used to type narrow metadata
    assert(
      metadata.type === TxSubmitterType.JSON_RPC,
      `Invalid metadata type: ${metadata.type}, expected ${TxSubmitterType.JSON_RPC}`,
    );
    return new EV5JsonRpcTxSubmitter(multiProvider, metadata);
  },
  [TxSubmitterType.IMPERSONATED_ACCOUNT]: (multiProvider, metadata) => {
    assert(
      metadata.type === TxSubmitterType.IMPERSONATED_ACCOUNT,
      `Invalid metadata type: ${metadata.type}, expected ${TxSubmitterType.IMPERSONATED_ACCOUNT}`,
    );
    return new EV5ImpersonatedAccountTxSubmitter(multiProvider, metadata);
  },
  [TxSubmitterType.GNOSIS_SAFE]: (multiProvider, metadata) => {
    assert(
      metadata.type === TxSubmitterType.GNOSIS_SAFE,
      `Invalid metadata type: ${metadata.type}, expected ${TxSubmitterType.GNOSIS_SAFE}`,
    );
    return EV5GnosisSafeTxSubmitter.create(multiProvider, metadata);
  },
  [TxSubmitterType.GNOSIS_TX_BUILDER]: (multiProvider, metadata) => {
    assert(
      metadata.type === TxSubmitterType.GNOSIS_TX_BUILDER,
      `Invalid metadata type: ${metadata.type}, expected ${TxSubmitterType.GNOSIS_TX_BUILDER}`,
    );
    return EV5GnosisSafeTxBuilder.create(multiProvider, metadata);
  },
  [TxSubmitterType.INTERCHAIN_ACCOUNT]: (multiProvider, metadata, registry) => {
    assert(
      metadata.type === TxSubmitterType.INTERCHAIN_ACCOUNT,
      `Invalid metadata type: ${metadata.type}, expected ${TxSubmitterType.INTERCHAIN_ACCOUNT}`,
    );
    return EvmIcaTxSubmitter.fromConfig(metadata, multiProvider, registry);
  },
};

export function registerSubmitter(
  type: string,
  factory: SubmitterFactory,
): void {
  if (Object.keys(submitterRegistry).includes(type)) {
    throw new Error(
      `Submitter factory for type ${type} is already registered.`,
    );
  }
  submitterRegistry[type] = factory;
}

export async function getSubmitter<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  submitterMetadata: SubmitterMetadata,
  registry: IRegistry,
): Promise<TxSubmitterInterface<TProtocol>> {
  const factory = submitterRegistry[submitterMetadata.type];
  if (!factory) {
    throw new Error(
      `No submitter factory registered for type ${submitterMetadata.type}`,
    );
  }
  return factory(multiProvider, submitterMetadata, registry);
}

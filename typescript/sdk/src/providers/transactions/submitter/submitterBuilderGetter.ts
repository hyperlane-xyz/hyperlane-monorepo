import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { ChainMap } from '../../../types.js';
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
import { EV5TimelockSubmitter } from './ethersV5/EV5TimelockSubmitter.js';
import { SubmitterMetadata } from './types.js';

export type SubmitterBuilderSettings = {
  submissionStrategy: SubmissionStrategy;
  multiProvider: MultiProvider;
  coreAddressesByChain: ChainMap<Record<string, string>>;
  additionalSubmitterFactories?: Record<string, SubmitterFactory>;
};

export async function getSubmitterBuilder<TProtocol extends ProtocolType>({
  submissionStrategy,
  multiProvider,
  coreAddressesByChain,
  additionalSubmitterFactories,
}: SubmitterBuilderSettings): Promise<TxSubmitterBuilder<TProtocol>> {
  const submitter = await getSubmitter<TProtocol>(
    multiProvider,
    submissionStrategy.submitter,
    coreAddressesByChain,
    additionalSubmitterFactories,
  );

  return new TxSubmitterBuilder<TProtocol>(submitter);
}

export type SubmitterFactory<TProtocol extends ProtocolType = any> = (
  multiProvider: MultiProvider,
  metadata: SubmitterMetadata,
  coreAddressesByChain: ChainMap<Record<string, string>>,
) => Promise<TxSubmitterInterface<TProtocol>> | TxSubmitterInterface<TProtocol>;

const defaultSubmitterFactories: Record<string, SubmitterFactory> = {
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
  [TxSubmitterType.INTERCHAIN_ACCOUNT]: (
    multiProvider,
    metadata,
    coreAddressesByChain,
  ) => {
    assert(
      metadata.type === TxSubmitterType.INTERCHAIN_ACCOUNT,
      `Invalid metadata type: ${metadata.type}, expected ${TxSubmitterType.INTERCHAIN_ACCOUNT}`,
    );
    return EvmIcaTxSubmitter.fromConfig(
      metadata,
      multiProvider,
      coreAddressesByChain,
    );
  },
  [TxSubmitterType.TIMELOCK_CONTROLLER]: (
    multiProvider,
    metadata,
    coreAddressesByChain,
  ) => {
    assert(
      metadata.type === TxSubmitterType.TIMELOCK_CONTROLLER,
      `Invalid metadata type: ${metadata.type}, expected ${TxSubmitterType.TIMELOCK_CONTROLLER}`,
    );

    return EV5TimelockSubmitter.fromConfig(
      metadata,
      multiProvider,
      coreAddressesByChain,
    );
  },
};

/**
 * Retrieves a transaction submitter instance based on the provided metadata.
 * This function acts as a factory, using a registry of submitter builders
 * to construct the appropriate submitter for the given protocol and submission strategy.
 * It allows for extending the default registry with custom submitter types.
 *
 * @param multiProvider - The MultiProvider instance
 * @param submitterMetadata - The metadata defining the type and configuration of the submitter.
 * @param coreAddressesByChain - The address of the core Hyperlane deployments by chain. Used for filling some default values for the submission strategies.
 * @param additionalSubmitterFactories optional extension to extend the default registry. Can override if specifying the the same key.
 * @returns A promise that resolves to an instance of a TxSubmitterInterface.
 * @throws If no submitter factory is registered for the type specified in the metadata.
 */
export async function getSubmitter<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  submitterMetadata: SubmitterMetadata,
  coreAddressesByChain: ChainMap<Record<string, string>>,
  additionalSubmitterFactories: Record<string, SubmitterFactory> = {},
): Promise<TxSubmitterInterface<TProtocol>> {
  const mergedSubmitterRegistry = {
    ...defaultSubmitterFactories,
    ...additionalSubmitterFactories,
  };
  const factory = mergedSubmitterRegistry[submitterMetadata.type];
  if (!factory) {
    throw new Error(
      `No submitter factory registered for type ${submitterMetadata.type}`,
    );
  }
  return factory(multiProvider, submitterMetadata, coreAddressesByChain);
}

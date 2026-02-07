import { z } from 'zod';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMap, ProtocolMap } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';

import { TxSubmitterInterface } from './TxSubmitterInterface.js';
import { EvmSubmitterMetadataSchema } from './ethersV5/types.js';

export const SubmitterMetadataSchema = EvmSubmitterMetadataSchema;
export type SubmitterMetadata = z.infer<typeof EvmSubmitterMetadataSchema>;

/**
 * Function type for getting a submitter instance.
 * Used for dependency injection to break circular imports.
 */
export type SubmitterGetter = <TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  submitterMetadata: SubmitterMetadata,
  coreAddressesByChain: ChainMap<Record<string, string>>,
  additionalSubmitterFactories?: ProtocolMap<Record<string, any>>,
) => Promise<TxSubmitterInterface<TProtocol>>;

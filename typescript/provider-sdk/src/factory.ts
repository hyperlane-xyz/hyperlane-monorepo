import { IProvider, ISigner } from './altvm.js';
import { ChainMetadataForAltVM } from './chain.js';
import { HookConfig } from './hook.js';
import { IsmConfig } from './ism.js';
import { AnnotatedTx, HypModuleFactory, TxReceipt } from './module.js';
import {
  ITransactionSubmitter,
  JsonRpcSubmitterConfig,
  TransactionSubmitterConfig,
} from './submitter.js';
import { WarpConfig } from './warp.js';

export type SignerConfig = Pick<
  JsonRpcSubmitterConfig,
  'privateKey' | 'accountAddress'
>;

/**
 * Interface describing the artifacts that should be implemented in a specific protocol
 * implementation
 */
export interface IProtocolProviderFactory {
  getProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider>;
  getSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<ISigner<AnnotatedTx, TxReceipt>>;
  getSubmitter(
    chainMetadata: ChainMetadataForAltVM,
    config: TransactionSubmitterConfig<never>,
  ): Promise<ITransactionSubmitter>;
  // TODO: better typing here instead of any
  ismFactory(): HypModuleFactory<IsmConfig, any>;
  hookFactory(): HypModuleFactory<HookConfig, any>;
  tokenRouterFactory(): HypModuleFactory<WarpConfig, any>;
}

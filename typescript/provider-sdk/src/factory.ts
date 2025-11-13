import { IProvider, ISigner } from './altvm.js';
import { ChainMetadataForAltVM } from './chain.js';
import { AnnotatedTx, TxReceipt } from './module.js';
import {
  ITransactionSubmitter,
  JsonRpcSubmitterConfig,
  TransactionSubmitterConfig,
} from './submitter.js';

export type SignerConfig = Pick<
  JsonRpcSubmitterConfig,
  'privateKey' | 'accountAddress'
>;

/**
 * Interface describing the artifacts that should be implemented in a specific protocol
 * implementation
 */
export interface ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider>;
  createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<ISigner<AnnotatedTx, TxReceipt>>;

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    chainMetadata: ChainMetadataForAltVM,
    config: TConfig,
  ): Promise<ITransactionSubmitter>;
  registerSubmitterFactory<TConfig extends TransactionSubmitterConfig>(
    type: string,
    factory: (
      chainMetadata: ChainMetadataForAltVM,
      config: TConfig,
    ) => Promise<ITransactionSubmitter>,
  ): void;
}

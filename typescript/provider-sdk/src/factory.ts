import { IProvider, ISigner } from './altvm.js';
import { ArtifactProvider } from './artifact.js';
import { ChainMetadataForAltVM } from './chain.js';
import { HookConfig } from './hook.js';
import { IsmConfig } from './ism.js';
import { AnnotatedTx, TxReceipt } from './module.js';
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
  ismProvider(): ArtifactProvider<IsmConfig, { ismAddress: string }>;
  hookProvider(): ArtifactProvider<HookConfig, { hookAddress: string }>;
  tokenRouterProvider(): ArtifactProvider<WarpConfig, { tokenAddress: string }>;
}

import { IProvider, ISigner } from './altvm.js';
import type { ArtifactProvider, Receipt, Transaction } from './artifact.js';
import { ChainMetadataForAltVM } from './chain.js';
import { HookArtifacts } from './hook.js';
import { IsmArtifacts } from './ism.js';
import { AnnotatedTx, TxReceipt } from './module.js';
import {
  ITransactionSubmitter,
  JsonRpcSubmitterConfig,
  TransactionSubmitterConfig,
} from './submitter.js';
import { TokenRouterArtifacts } from './warp.js';

export type SignerConfig = Pick<
  JsonRpcSubmitterConfig,
  'privateKey' | 'accountAddress'
>;

/**
 * Interface describing the artifacts that should be implemented in a specific protocol
 * implementation
 */
export interface ProtocolProvider {
  // FIXME the plan for this part is to morph provider/signer implementations into separate
  // artifact implementations (core, ISM, hook, token router);
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
  ismProvider(): ArtifactProvider<IsmArtifacts>;
  hookProvider(): ArtifactProvider<HookArtifacts>;
  tokenRouterProvider(): ArtifactProvider<TokenRouterArtifacts>;
}

/* --------------------------------------------------------------- */

// Provider registration flow:
//  load(protocol_name) -> register_fn(registry) -> create_provider(protocol_name)
//  1. The app loader loads the protocol module by name (or package name)
//  2. The protocol module registers itself with the registry
//  3. The app loader creates a provider instance by protocol name

// Provider usage flow:
//  (chain_meta, credentials) -> (provider, signer) -> (artifacts)
//  1. The app logic creates a provider/signer for a given chain (and credentials)
//  2. The app logic uses the provider/signer to get an artifact object (ISM, hook, token router)
//  3. The app logic uses the artifact object to perform its tasks

// To be merged with ProtocolProvider
export interface ProtocolProviderPoc {
  createReader(chainMetadata: ChainMetadataForAltVM): ProtocolReader;
  createWriter(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): ProtocolWriter;
  ismProvider(): ArtifactProvider<IsmArtifacts>;
  hookProvider(): ArtifactProvider<HookArtifacts>;
}

export interface ProtocolReader {
  getNativeBalance(address: string): Promise<bigint>;
  estimateTransactionFee(tx: Transaction): Promise<bigint>;
}

export interface ProtocolWriter {
  submitTransaction(tx: Transaction): Promise<Receipt>;
}

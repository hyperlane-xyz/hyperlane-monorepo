import { IProvider, ISigner } from './altvm.js';
import { ChainMetadataForAltVM } from './chain.js';
import { CoreModuleType } from './core.js';
import { HookModuleType } from './hook.js';
import { IsmModuleType } from './ism.js';
import { AnnotatedTx, ModuleProvider, TxReceipt } from './module.js';
import {
  ITransactionSubmitter,
  JsonRpcSubmitterConfig,
  TransactionSubmitterConfig,
} from './submitter.js';
import { TokenRouterModuleType } from './warp.js';

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

  // It's unclear if these belong here or in a separate interface
  // Currently they can only be implemented in deploy-sdk for AltVM classes
  coreProvider(): ModuleProvider<CoreModuleType>;
  hookProvider(): ModuleProvider<HookModuleType>;
  ismProvider(): ModuleProvider<IsmModuleType>;
  tokenRouterProvider(): ModuleProvider<TokenRouterModuleType>;
}

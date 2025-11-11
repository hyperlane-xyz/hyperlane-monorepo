import { WithAddress } from '@hyperlane-xyz/utils';

import { IProvider, ISigner } from './altvm.js';
import { AnnotatedTx, HypModuleFactory, TxReceipt } from './module.js';

export interface ArtifactReader<TConfig> {
  read(address: string): Promise<WithAddress<TConfig>>;
}

export interface ArtifactProvider<
  TConfig,
  TAddressMap extends Record<string, unknown>,
> {
  availableTypes: () => (keyof TConfig)[];
  createReader: (provider: IProvider) => ArtifactReader<TConfig>;
  createModuleFactory: (
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ) => HypModuleFactory<TConfig, TAddressMap>;
}

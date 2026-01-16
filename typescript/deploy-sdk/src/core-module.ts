import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ChainLookup,
  ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk/chain';
import { CoreConfig, CoreModuleType } from '@hyperlane-xyz/provider-sdk/core';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
  ModuleProvider,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { AltVMCoreModule } from './AltVMCoreModule.js';
import { AltVMCoreReader } from './AltVMCoreReader.js';

class CoreModuleProvider implements ModuleProvider<CoreModuleType> {
  constructor(
    private chainLookup: ChainLookup,
    private chainMetadata: ChainMetadataForAltVM,
  ) {}

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: CoreConfig,
  ): Promise<HypModule<CoreModuleType>> {
    return await AltVMCoreModule.create({
      chainLookup: this.chainLookup,
      chain: this.chainMetadata.name,
      signer,
      config,
    });
  }

  connectModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<CoreModuleType>,
  ): HypModule<CoreModuleType> {
    return new AltVMCoreModule(this.chainLookup, signer, args);
  }

  connectReader(provider: IProvider<any>): HypReader<CoreModuleType> {
    return new AltVMCoreReader(this.chainMetadata, this.chainLookup, provider);
  }
}

export function coreModuleProvider(
  chainLookup: ChainLookup,
  chainMetadata: ChainMetadataForAltVM,
): ModuleProvider<CoreModuleType> {
  return new CoreModuleProvider(chainLookup, chainMetadata);
}

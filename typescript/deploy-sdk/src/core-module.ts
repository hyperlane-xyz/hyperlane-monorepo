import {
  type IProvider,
  type ISigner,
} from '@hyperlane-xyz/provider-sdk/altvm';
import { type ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  type CoreConfig,
  type CoreModuleType,
} from '@hyperlane-xyz/provider-sdk/core';
import {
  type AnnotatedTx,
  type HypModule,
  type HypModuleArgs,
  type HypReader,
  type ModuleProvider,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { AltVMCoreModule } from './AltVMCoreModule.js';
import { AltVMCoreReader } from './AltVMCoreReader.js';

class CoreModuleProvider implements ModuleProvider<CoreModuleType> {
  constructor(
    private chainLookup: ChainLookup,
    private chainName: string,
  ) {}

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: CoreConfig,
  ): Promise<HypModule<CoreModuleType>> {
    return await AltVMCoreModule.create({
      chainLookup: this.chainLookup,
      chain: this.chainName,
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
    return new AltVMCoreReader(this.chainLookup, provider);
  }
}

export function coreModuleProvider(
  chainLookup: ChainLookup,
  chainName: string,
): ModuleProvider<CoreModuleType> {
  return new CoreModuleProvider(chainLookup, chainName);
}

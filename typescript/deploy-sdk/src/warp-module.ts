import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
  ModuleProvider,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  TokenRouterModuleType,
  WarpConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { AltVMWarpModule } from './AltVMWarpModule.js';
import { AltVMWarpRouteReader } from './AltVMWarpRouteReader.js';

class WarpModuleProvider implements ModuleProvider<TokenRouterModuleType> {
  constructor(
    private chainLookup: ChainLookup,
    private chainName: string,
  ) {}

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: WarpConfig,
  ): Promise<HypModule<TokenRouterModuleType>> {
    return await AltVMWarpModule.create({
      chainLookup: this.chainLookup,
      chain: this.chainName,
      signer,
      config,
    });
  }

  connectModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<TokenRouterModuleType>,
  ): HypModule<TokenRouterModuleType> {
    return new AltVMWarpModule(this.chainLookup, signer, args);
  }

  connectReader(provider: IProvider<any>): HypReader<TokenRouterModuleType> {
    return new AltVMWarpRouteReader(this.chainLookup, provider);
  }
}

export function warpModuleProvider(
  chainLookup: ChainLookup,
  chainName: string,
): ModuleProvider<TokenRouterModuleType> {
  return new WarpModuleProvider(chainLookup, chainName);
}

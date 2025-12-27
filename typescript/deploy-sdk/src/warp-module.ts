import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ChainLookup,
  ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk/chain';
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
    private chainMetadata: ChainMetadataForAltVM,
  ) {}

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: WarpConfig,
  ): Promise<HypModule<TokenRouterModuleType>> {
    return await AltVMWarpModule.create({
      chainLookup: this.chainLookup,
      chain: this.chainMetadata.name,
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
    return new AltVMWarpRouteReader(
      this.chainMetadata,
      this.chainLookup,
      provider,
    );
  }
}

export function warpModuleProvider(
  chainLookup: ChainLookup,
  chainMetadata: ChainMetadataForAltVM,
): ModuleProvider<TokenRouterModuleType> {
  return new WarpModuleProvider(chainLookup, chainMetadata);
}

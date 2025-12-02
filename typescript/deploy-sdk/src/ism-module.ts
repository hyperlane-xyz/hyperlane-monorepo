import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  IsmConfig,
  IsmModuleAddresses,
  IsmModuleType,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
  ModuleProvider,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { AltVMIsmModule } from './AltVMIsmModule.js';
import { AltVMIsmReader } from './AltVMIsmReader.js';

class IsmModuleProvider implements ModuleProvider<IsmModuleType> {
  constructor(
    private chainLookup: ChainLookup,
    private chainName: string,
    private mailboxAddress: string,
  ) {}

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: IsmConfig,
  ): Promise<HypModule<IsmModuleType>> {
    const addresses: IsmModuleAddresses = {
      deployedIsm: '', // Will be populated by the module
      mailbox: this.mailboxAddress,
    };

    return await AltVMIsmModule.create({
      chainLookup: this.chainLookup,
      chain: this.chainName,
      signer,
      config,
      addresses,
    });
  }

  connectModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<IsmModuleType>,
  ): HypModule<IsmModuleType> {
    return new AltVMIsmModule(this.chainLookup, args, signer);
  }

  connectReader(provider: IProvider<any>): HypReader<IsmModuleType> {
    return new AltVMIsmReader(this.chainLookup.getChainName, provider);
  }
}

export function ismModuleProvider(
  chainLookup: ChainLookup,
  chainName: string,
  mailboxAddress: string,
): ModuleProvider<IsmModuleType> {
  return new IsmModuleProvider(chainLookup, chainName, mailboxAddress);
}

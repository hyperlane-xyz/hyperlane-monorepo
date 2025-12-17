import {
  type IProvider,
  type ISigner,
} from '@hyperlane-xyz/provider-sdk/altvm';
import { type ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  type HookConfig,
  type HookModuleAddresses,
  type HookModuleType,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  type AnnotatedTx,
  type HypModule,
  type HypModuleArgs,
  type HypReader,
  type ModuleProvider,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { AltVMHookModule } from './AltVMHookModule.js';
import { AltVMHookReader } from './AltVMHookReader.js';

class HookModuleProvider implements ModuleProvider<HookModuleType> {
  constructor(
    private chainLookup: ChainLookup,
    private chainName: string,
    private mailboxAddress: string,
  ) {}

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: HookConfig,
  ): Promise<HypModule<HookModuleType>> {
    const addresses: HookModuleAddresses = {
      deployedHook: '', // Will be populated by the module
      mailbox: this.mailboxAddress,
    };

    return await AltVMHookModule.create({
      chainLookup: this.chainLookup,
      chain: this.chainName,
      signer,
      config,
      addresses,
    });
  }

  connectModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<HookModuleType>,
  ): HypModule<HookModuleType> {
    return new AltVMHookModule(this.chainLookup, args, signer);
  }

  connectReader(provider: IProvider<any>): HypReader<HookModuleType> {
    return new AltVMHookReader(this.chainLookup.getChainMetadata, provider);
  }
}

export function hookModuleProvider(
  chainLookup: ChainLookup,
  chainName: string,
  mailboxAddress: string,
): ModuleProvider<HookModuleType> {
  return new HookModuleProvider(chainLookup, chainName, mailboxAddress);
}

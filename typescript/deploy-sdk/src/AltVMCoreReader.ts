import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  CoreModuleType,
  DerivedCoreConfig,
} from '@hyperlane-xyz/provider-sdk/core';
import { HypReader } from '@hyperlane-xyz/provider-sdk/module';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { AltVMHookReader } from './AltVMHookReader.js';
import { AltVMIsmReader } from './AltVMIsmReader.js';

export class AltVMCoreReader implements HypReader<CoreModuleType> {
  protected readonly logger = rootLogger.child({
    module: 'AltVMCoreReader',
  });
  protected ismReader: AltVMIsmReader;
  protected hookReader: AltVMHookReader;

  constructor(
    chainLookup: ChainLookup,
    protected readonly provider: AltVM.IProvider,
  ) {
    this.ismReader = new AltVMIsmReader(
      chainLookup.getChainName,
      this.provider,
    );
    this.hookReader = new AltVMHookReader(
      chainLookup.getChainMetadata,
      this.provider,
    );
  }

  async read(address: string): Promise<DerivedCoreConfig> {
    return this.deriveCoreConfig(address);
  }

  async deriveCoreConfig(mailboxAddress: Address): Promise<DerivedCoreConfig> {
    const mailbox = await this.provider.getMailbox({
      mailboxAddress: mailboxAddress,
    });

    return {
      owner: mailbox.owner,
      defaultIsm: await this.ismReader.deriveIsmConfig(mailbox.defaultIsm),
      defaultHook: await this.hookReader.deriveHookConfig(mailbox.defaultHook),
      requiredHook: await this.hookReader.deriveHookConfig(
        mailbox.requiredHook,
      ),
    };
  }
}

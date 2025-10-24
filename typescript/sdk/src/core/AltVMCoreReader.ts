import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import {
  AltVMHookReader,
  ChainMetadataLookup as HookChainMetadataLookup,
} from '../hook/AltVMHookReader.js';
import { AltVMIsmReader, ChainNameLookup } from '../ism/AltVMIsmReader.js';

import { DerivedCoreConfig } from './types.js';

export class AltVMCoreReader {
  protected readonly logger = rootLogger.child({
    module: 'AltVMCoreReader',
  });
  protected ismReader: AltVMIsmReader;
  protected hookReader: AltVMHookReader;

  constructor(
    getChainMetadataForHook: HookChainMetadataLookup,
    getChainNameFromDomain: ChainNameLookup,
    protected readonly provider: AltVM.IProvider,
  ) {
    this.ismReader = new AltVMIsmReader(getChainNameFromDomain, this.provider);
    this.hookReader = new AltVMHookReader(
      getChainMetadataForHook,
      this.provider,
    );
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

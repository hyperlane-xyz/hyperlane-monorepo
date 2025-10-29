import { AltVMHookReader, AltVMIsmReader } from '@hyperlane-xyz/deploy-sdk';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { DerivedCoreConfig } from './types.js';

export class AltVMCoreReader {
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

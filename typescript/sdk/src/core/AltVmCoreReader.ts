import { Address, AltVM, rootLogger } from '@hyperlane-xyz/utils';

import { AltVMHookReader } from '../hook/AltVMHookReader.js';
import { AltVMIsmReader } from '../ism/AltVMIsmReader.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import { DerivedCoreConfig } from './types.js';

export class AltVMCoreReader {
  protected readonly logger = rootLogger.child({
    module: 'AltVMCoreReader',
  });
  protected ismReader: AltVMIsmReader;
  protected hookReader: AltVMHookReader;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly provider: AltVM.IProvider,
  ) {
    this.ismReader = new AltVMIsmReader(this.metadataManager, this.provider);
    this.hookReader = new AltVMHookReader(this.metadataManager, this.provider);
  }

  async deriveCoreConfig(mailboxAddress: Address): Promise<DerivedCoreConfig> {
    const mailbox = await this.provider.getMailbox({
      mailbox_id: mailboxAddress,
    });

    return {
      owner: mailbox.owner,
      defaultIsm: await this.ismReader.deriveIsmConfig(mailbox.default_ism),
      defaultHook: await this.hookReader.deriveHookConfig(mailbox.default_hook),
      requiredHook: await this.hookReader.deriveHookConfig(
        mailbox.required_hook,
      ),
    };
  }
}

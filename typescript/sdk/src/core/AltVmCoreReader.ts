import { Address, AltVM, rootLogger } from '@hyperlane-xyz/utils';

import { AltVmHookReader } from '../hook/AltVmHookReader.js';
import { AltVmIsmReader } from '../ism/AltVmIsmReader.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import { DerivedCoreConfig } from './types.js';

export class AltVmCoreReader {
  protected readonly logger = rootLogger.child({
    module: 'AltVmCoreReader',
  });
  protected ismReader: AltVmIsmReader;
  protected hookReader: AltVmHookReader;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly provider: AltVM.IProvider,
  ) {
    this.ismReader = new AltVmIsmReader(this.metadataManager, this.provider);
    this.hookReader = new AltVmHookReader(this.metadataManager, this.provider);
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

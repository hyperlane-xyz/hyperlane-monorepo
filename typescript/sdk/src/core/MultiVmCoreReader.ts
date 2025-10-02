import { Address, MultiVM, rootLogger } from '@hyperlane-xyz/utils';

import { MultiVmHookReader } from '../hook/MultiVmHookReader.js';
import { MultiVmIsmReader } from '../ism/MultiVmIsmReader.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import { DerivedCoreConfig } from './types.js';

export class MultiVmCoreReader {
  protected readonly logger = rootLogger.child({
    module: 'MultiVmCoreReader',
  });
  protected ismReader: MultiVmIsmReader;
  protected hookReader: MultiVmHookReader;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly provider: MultiVM.IProvider,
  ) {
    this.ismReader = new MultiVmIsmReader(this.metadataManager, this.provider);
    this.hookReader = new MultiVmHookReader(
      this.metadataManager,
      this.provider,
    );
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

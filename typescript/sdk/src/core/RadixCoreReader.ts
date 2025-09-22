import { RadixSDK } from '@hyperlane-xyz/radix-sdk';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import { RadixHookReader } from '../hook/RadixHookReader.js';
import { RadixIsmReader } from '../ism/RadixIsmReader.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import { DerivedCoreConfig } from './types.js';

export class RadixCoreReader {
  protected readonly logger = rootLogger.child({
    module: 'RadixCoreReader',
  });
  protected ismReader: RadixIsmReader;
  protected hookReader: RadixHookReader;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly sdk: RadixSDK,
  ) {
    this.ismReader = new RadixIsmReader(this.metadataManager, this.sdk);
    this.hookReader = new RadixHookReader(this.metadataManager, this.sdk);
  }

  async deriveCoreConfig(mailboxAddress: Address): Promise<DerivedCoreConfig> {
    const mailbox = await this.sdk.query.core.getMailbox({
      mailbox: mailboxAddress,
    });

    assert(mailbox, `Mailbox not found for address ${mailboxAddress}`);

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

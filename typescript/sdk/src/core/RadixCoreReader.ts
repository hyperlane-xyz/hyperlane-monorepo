import { RadixSDK, RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

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
    protected readonly sdk: RadixSDK | RadixSigningSDK,
  ) {
    this.ismReader = new RadixIsmReader(this.metadataManager, this.sdk);
    this.hookReader = new RadixHookReader(this.metadataManager, this.sdk);
  }

  async deriveCoreConfig(mailboxAddress: Address): Promise<DerivedCoreConfig> {
    const mailbox = await this.sdk.queryMailbox(mailboxAddress);

    if (!mailbox) {
      throw new Error(`Mailbox not found for address ${mailboxAddress}`);
    }

    return {
      owner: 'todo',
      defaultIsm: await this.ismReader.deriveIsmConfig(mailbox.defaultIsm),
      defaultHook: await this.hookReader.deriveHookConfig(mailbox.defaultHook),
      requiredHook: await this.hookReader.deriveHookConfig(
        mailbox.requiredHook,
      ),
    };
  }
}

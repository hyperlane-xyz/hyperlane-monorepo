import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ChainLookup,
  ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk/chain';
import {
  CoreModuleType,
  DerivedCoreConfig,
} from '@hyperlane-xyz/provider-sdk/core';
import { HypReader } from '@hyperlane-xyz/provider-sdk/module';
import { Address, Logger, rootLogger } from '@hyperlane-xyz/utils';

import { createHookReader } from './hook/hook-reader.js';
import { IsmReader, createIsmReader } from './ism/generic-ism.js';

export class AltVMCoreReader implements HypReader<CoreModuleType> {
  protected readonly logger: Logger = rootLogger.child({
    module: 'AltVMCoreReader',
  });
  private readonly ismReader: IsmReader;

  constructor(
    protected readonly chainMetadata: ChainMetadataForAltVM,
    protected readonly chainLookup: ChainLookup,
    protected readonly provider: AltVM.IProvider,
  ) {
    this.ismReader = createIsmReader(this.chainMetadata, this.chainLookup);
  }

  async read(address: string): Promise<DerivedCoreConfig> {
    return this.deriveCoreConfig(address);
  }

  async deriveCoreConfig(mailboxAddress: Address): Promise<DerivedCoreConfig> {
    const mailbox = await this.provider.getMailbox({
      mailboxAddress: mailboxAddress,
    });

    const hookReader = createHookReader(this.chainMetadata, this.chainLookup, {
      mailbox: mailboxAddress,
    });

    return {
      owner: mailbox.owner,
      defaultIsm: await this.ismReader.deriveIsmConfig(mailbox.defaultIsm),
      defaultHook: await hookReader.deriveHookConfig(mailbox.defaultHook),
      requiredHook: await hookReader.deriveHookConfig(mailbox.requiredHook),
    };
  }
}

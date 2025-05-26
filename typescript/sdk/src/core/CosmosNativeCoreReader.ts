import {
  HyperlaneModuleClient,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { CosmosNativeHookReader } from '../hook/CosmosNativeHookReader.js';
import { CosmosNativeIsmReader } from '../ism/CosmosNativeIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { DerivedCoreConfig } from './types.js';

export class CosmosNativeCoreReader {
  protected readonly logger = rootLogger.child({
    module: 'CosmosNativeCoreReader',
  });
  protected ismReader: CosmosNativeIsmReader;
  protected hookReader: CosmosNativeHookReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly signer:
      | HyperlaneModuleClient
      | SigningHyperlaneModuleClient,
  ) {
    this.ismReader = new CosmosNativeIsmReader(this.multiProvider, this.signer);
    this.hookReader = new CosmosNativeHookReader(
      this.multiProvider,
      this.signer,
    );
  }

  async deriveCoreConfig(mailboxAddress: Address): Promise<DerivedCoreConfig> {
    const { mailbox } = await this.signer.query.core.Mailbox({
      id: mailboxAddress,
    });

    if (!mailbox) {
      throw new Error(`Mailbox not found for address ${mailboxAddress}`);
    }

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

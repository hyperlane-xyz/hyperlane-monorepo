import { num } from 'starknet';

import { DerivedCoreConfig } from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetHookReader } from '../hook/StarknetHookReader.js';
import { StarknetIsmReader } from '../ism/StarknetIsmReader.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { StarknetJsProvider } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';
import { getStarknetMailboxContract } from '../utils/starknet.js';

export class StarknetCoreReader {
  protected readonly logger = rootLogger.child({
    module: 'StarknetCoreReader',
  });
  protected provider: StarknetJsProvider['provider'];
  protected ismReader: StarknetIsmReader;
  protected hookReader: StarknetHookReader;

  constructor(
    protected readonly multiProvider: MultiProtocolProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    this.provider = this.multiProvider.getStarknetProvider(chain);
    this.ismReader = new StarknetIsmReader(this.multiProvider, this.chain);
    this.hookReader = new StarknetHookReader(this.multiProvider, this.chain);
  }

  async deriveCoreConfig(mailboxAddress: Address): Promise<DerivedCoreConfig> {
    const mailbox = getStarknetMailboxContract(mailboxAddress, this.provider);

    const [defaultIsm, defaultHook, requiredHook, owner] = (
      await Promise.all([
        mailbox.get_default_ism(),
        mailbox.get_default_hook(),
        mailbox.get_required_hook(),
        mailbox.owner(),
      ])
    ).map((res) => num.toHex64(res.toString()));

    return {
      owner,
      defaultIsm: await this.ismReader.deriveIsmConfig(defaultIsm),
      defaultHook: await this.hookReader.deriveHookConfig(defaultHook),
      requiredHook: await this.hookReader.deriveHookConfig(requiredHook),
    };
  }
}

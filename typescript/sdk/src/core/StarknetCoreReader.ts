import { Account, Contract, num } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetHookReader } from '../hook/StarknetHookReader.js';
import { StarknetIsmReader } from '../ism/StarknetIsmReader.js';

import { CoreConfig } from './types.js';

export class StarknetCoreReader {
  protected readonly logger = rootLogger.child({
    module: 'StarknetCoreReader',
  });
  protected ismReader: StarknetIsmReader;
  protected hookReader: StarknetHookReader;

  constructor(protected readonly signer: Account) {
    this.ismReader = new StarknetIsmReader(this.signer);
    this.hookReader = new StarknetHookReader(this.signer);
  }

  async deriveCoreConfig(mailboxAddress: Address): Promise<CoreConfig> {
    const { abi } = getCompiledContract('mailbox');
    const mailbox = new Contract(abi, mailboxAddress, this.signer);

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

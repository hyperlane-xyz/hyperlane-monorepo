import { Address, HexString } from '@hyperlane-xyz/utils';

import { BaseCosmosAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { TypedTransactionReceipt } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

export class RadixCoreAdapter
  extends BaseCosmosAdapter
  implements ICoreAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  extractMessageIds(
    _sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    // TODO: RADIX

    return [];
  }

  async waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    _delayMs?: number,
    _maxAttempts?: number,
  ): Promise<boolean> {
    const provider = this.multiProvider.getRadixProvider(destination);

    await provider.query.pollForCommit(messageId);
    return true;
  }
}

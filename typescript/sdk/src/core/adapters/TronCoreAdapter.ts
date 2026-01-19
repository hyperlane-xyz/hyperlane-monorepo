import { ethers } from 'ethers';

import {
  Address,
  HexString,
  assert,
  ensure0x,
  messageId,
  pollAsync,
} from '@hyperlane-xyz/utils';

import { BaseTronAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

export class TronCoreAdapter extends BaseTronAdapter implements ICoreAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.Tron) {
      throw new Error(`sourceTx has invalid provider type ${sourceTx.type}`);
    }

    const iface = new ethers.utils.Interface([
      'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
    ]);

    const results: { messageId: string; destination: ChainName }[] = [];

    for (const log of sourceTx.receipt.log) {
      try {
        const parsedLog = iface.parseLog({
          topics: log.topics.map((t) => ensure0x(t)),
          data: ensure0x(log.data),
        });

        results.push({
          messageId: messageId(parsedLog.args.message),
          destination: this.multiProvider.getChainName(
            parsedLog.args.destination,
          ),
        });
      } catch {
        continue;
      }
    }

    return results;
  }

  async waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean> {
    const provider = this.multiProvider.getTronProvider(destination);

    await pollAsync(
      async () => {
        this.logger.debug(`Checking if message ${messageId} was processed`);
        const delivered = await provider.isMessageDelivered({
          mailboxAddress: this.addresses.mailbox,
          messageId: messageId,
        });

        assert(delivered, `Message ${messageId} not yet processed`);

        this.logger.info(`Message ${messageId} was processed`);
        return delivered;
      },
      delayMs,
      maxAttempts,
    );

    return true;
  }
}

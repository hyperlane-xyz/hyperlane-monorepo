import { Address, HexString, assert, pollAsync } from '@hyperlane-xyz/utils';

import { BaseAleoAdapter } from '../../app/MultiProtocolApp.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { TypedTransactionReceipt } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

export class AleoCoreAdapter extends BaseAleoAdapter implements ICoreAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProviderAdapter<any>,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async extractMessageIds(
    _sourceTx: TypedTransactionReceipt,
  ): Promise<Array<{ messageId: string; destination: ChainName }>> {
    const provider = this.multiProvider.getAleoProvider(this.chainName);

    // The mailbox nonce is incremented during finalize, so after the tx
    // confirms the dispatch used nonce = current_nonce - 1.
    const mailbox = await provider.getMailbox({
      mailboxAddress: this.addresses.mailbox,
    });
    const nonce = mailbox.nonce - 1;

    const [messageId, destinationDomain] = await Promise.all([
      provider.getDispatchedMessageId(this.addresses.mailbox, nonce),
      provider.getDispatchedDestinationDomain(this.addresses.mailbox, nonce),
    ]);

    if (!messageId || destinationDomain == null) {
      this.logger.warn(
        `Could not extract message ID or destination from Aleo dispatch at nonce ${nonce}`,
      );
      return [];
    }

    const destination = this.multiProvider.tryGetChainName(destinationDomain);
    if (!destination) {
      this.logger.warn(`Unknown destination domain ${destinationDomain}`);
      return [];
    }

    return [{ messageId, destination }];
  }

  async waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean> {
    const provider = this.multiProvider.getAleoProvider(destination);

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

  async isDelivered(
    messageId: HexString,
    _blockTag?: string | number,
  ): Promise<boolean> {
    const provider = this.multiProvider.getAleoProvider(this.chainName);
    return provider.isMessageDelivered({
      mailboxAddress: this.addresses.mailbox,
      messageId: messageId,
    });
  }
}

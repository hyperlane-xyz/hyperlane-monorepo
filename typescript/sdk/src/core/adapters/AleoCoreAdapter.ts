import { Address, HexString, assert, pollAsync } from '@hyperlane-xyz/utils';

import { BaseAleoAdapter } from '../../app/MultiProtocolApp.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
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
    sourceTx: TypedTransactionReceipt,
  ): Promise<Array<{ messageId: string; destination: ChainName }>> {
    if (sourceTx.type !== ProviderType.Aleo) {
      return [];
    }

    if (!this.addresses.mailbox) {
      this.logger.debug(
        'No Aleo mailbox address configured; skipping message ID extraction',
      );
      return [];
    }

    if (sourceTx.receipt.type !== 'execute') {
      this.logger.warn(
        `Aleo dispatch transaction was rejected (type=${sourceTx.receipt.type}); no message dispatched`,
      );
      return [];
    }

    const provider = this.multiProvider.getAleoProvider(this.chainName);
    const txId = sourceTx.receipt.transactionHash;

    // Use dispatch_event_index[block_height] to find the exact nonce for this
    // transaction's block — same approach as the Rust relayer's block-level anchor.
    const dispatchNonce = await provider.getDispatchNonceForTx(
      this.addresses.mailbox,
      txId,
    );
    if (dispatchNonce == null) {
      this.logger.warn(
        `No dispatch_event_index entry for tx ${txId}; no message dispatched`,
      );
      return [];
    }

    const [messageId, destinationDomain] = await Promise.all([
      provider.getDispatchedMessageId(this.addresses.mailbox, dispatchNonce),
      provider.getDispatchedDestinationDomain(
        this.addresses.mailbox,
        dispatchNonce,
      ),
    ]);

    if (!messageId || destinationDomain == null) {
      this.logger.warn(
        `Could not fetch message ID or destination for nonce ${dispatchNonce}`,
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

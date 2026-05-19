import { toKeyId } from '@hyperlane-xyz/aleo-sdk/runtime';
import { Address, HexString, assert, pollAsync } from '@hyperlane-xyz/utils';

import { BaseAleoAdapter } from '../../app/MultiProtocolApp.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

// How many nonces to search backward from the current mailbox nonce.
// Covers any concurrent dispatches between tx submission and this query.
const NONCE_SEARCH_WINDOW = 32;

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

    const finalizeKeyIds = new Set(
      sourceTx.receipt.finalize?.map((op) => op.key_id) ?? [],
    );

    if (finalizeKeyIds.size === 0) {
      this.logger.warn(
        'No finalize ops in Aleo receipt; cannot extract message ID',
      );
      return [];
    }

    // Unlike EVM/SVM adapters that parse receipt logs, Aleo extraction requires
    // querying on-chain mappings. Callers that construct MultiProtocolCore for an
    // Aleo origin chain must supply a real mailbox address, not a stub.
    if (!this.addresses.mailbox) {
      this.logger.debug(
        'No Aleo mailbox address configured; skipping message ID extraction',
      );
      return [];
    }

    const provider = this.multiProvider.getAleoProvider(this.chainName);
    const mailbox = await provider.getMailbox({
      mailboxAddress: this.addresses.mailbox,
    });

    // mailboxAddress is either "programId/address" or just "programId"
    const programId = this.addresses.mailbox.includes('/')
      ? this.addresses.mailbox.split('/')[0]
      : this.addresses.mailbox;

    // Search backward from current nonce matching dispatch_id_events key_ids
    // against those actually written by this specific transaction's finalize ops.
    let foundNonce: number | undefined;
    const upperBound = mailbox.nonce;
    const lowerBound = Math.max(0, upperBound - NONCE_SEARCH_WINDOW);
    for (let nonce = upperBound - 1; nonce >= lowerBound; nonce--) {
      const expectedKeyId = toKeyId(
        programId,
        'dispatch_id_events',
        `${nonce}u32`,
      );
      if (finalizeKeyIds.has(expectedKeyId)) {
        foundNonce = nonce;
        break;
      }
    }

    if (foundNonce === undefined) {
      this.logger.warn(
        `No dispatch_id_events key_id found in receipt finalize ops (searched ${NONCE_SEARCH_WINDOW} nonces from ${upperBound})`,
      );
      return [];
    }

    const [messageId, destinationDomain] = await Promise.all([
      provider.getDispatchedMessageId(this.addresses.mailbox, foundNonce),
      provider.getDispatchedDestinationDomain(
        this.addresses.mailbox,
        foundNonce,
      ),
    ]);

    if (!messageId || destinationDomain == null) {
      this.logger.warn(
        `Could not fetch message ID or destination for nonce ${foundNonce}`,
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

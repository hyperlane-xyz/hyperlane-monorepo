import { PublicKey } from '@solana/web3.js';

import { HexString, pollAsync } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType';
import { ChainName } from '../../types';
import { CoreAddresses } from '../contracts';

import { ICoreAdapter } from './types';

// https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/mailbox/src/processor.rs
const MESSAGE_DISPATCH_LOG_REGEX = /Dispatched message to (.*), ID (.*)/;

// This adapter just routes to the HyperlaneCore
// Which implements the needed functionality for EVM chains
export class SealevelCoreAdapter
  extends BaseSealevelAdapter<CoreAddresses>
  implements ICoreAdapter
{
  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: HexString; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.SolanaWeb3) {
      throw new Error(
        `Unsupported provider type for SealevelCoreAdapter ${sourceTx.type}`,
      );
    }
    const receipt = sourceTx.receipt;
    const logs = receipt.meta?.logMessages;
    if (!logs)
      throw new Error('Transaction logs required to check message delivery');
    const parsedLogs = SealevelCoreAdapter.parseMessageDispatchLogs(logs);
    if (!parsedLogs.length) throw new Error('Message dispatch log not found');
    return parsedLogs.map(({ destination, messageId }) => ({
      messageId: Buffer.from(messageId, 'hex').toString('hex'),
      destination: this.multiProvider.getChainName(destination),
    }));
  }

  async waitForMessageProcessed(
    messageId: string,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<void> {
    const destinationMailbox =
      this.multiProvider.getChainMetadata(destination).mailbox;
    const pda = SealevelCoreAdapter.deriveMailboxMessageProcessedPda(
      destinationMailbox,
      messageId,
    );
    const connection = this.multiProvider.getSolanaWeb3Provider(destination);

    await pollAsync(
      async () => {
        // If the PDA exists, then the message has been processed
        // Checking existence by querying for balance
        await connection.getBalance(pda);
        return;
      },
      delayMs,
      maxAttempts,
    );
  }

  static parseMessageDispatchLogs(
    logs: string[],
  ): Array<{ destination: string; messageId: string }> {
    const result: Array<{ destination: string; messageId: string }> = [];
    for (const log of logs) {
      if (!MESSAGE_DISPATCH_LOG_REGEX.test(log)) continue;
      const [, destination, messageId] = MESSAGE_DISPATCH_LOG_REGEX.exec(log)!;
      if (destination && messageId) result.push({ destination, messageId });
    }
    return result;
  }

  /*
   * Methods for deriving PDA addresses
   * Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/mailbox/src/pda_seeds.rs
   */

  static deriveMailboxInboxPda(
    mailboxProgramId: string | PublicKey,
  ): PublicKey {
    return super.derivePda(['hyperlane', '-', 'inbox'], mailboxProgramId);
  }

  static deriveMailboxOutboxPda(
    mailboxProgramId: string | PublicKey,
  ): PublicKey {
    return super.derivePda(['hyperlane', '-', 'outbox'], mailboxProgramId);
  }

  static deriveMailboxDispatchedMessagePda(
    mailboxProgramId: string | PublicKey,
    uniqueMessageAccount: string | PublicKey,
  ): PublicKey {
    return super.derivePda(
      [
        'hyperlane',
        '-',
        'dispatched_message',
        '-',
        new PublicKey(uniqueMessageAccount).toBuffer(),
      ],
      mailboxProgramId,
    );
  }

  static deriveMailboxDispatchAuthorityPda(
    programId: string | PublicKey,
  ): PublicKey {
    return super.derivePda(
      ['hyperlane_dispatcher', '-', 'dispatch_authority'],
      programId,
    );
  }

  static deriveMailboxProcessAuthorityPda(
    mailboxProgramId: string | PublicKey,
    recipient: string | PublicKey,
  ): PublicKey {
    return super.derivePda(
      [
        'hyperlane',
        '-',
        'process_authority',
        '-',
        new PublicKey(recipient).toBuffer(),
      ],
      mailboxProgramId,
    );
  }

  static deriveMailboxMessageProcessedPda(
    mailboxProgramId: string | PublicKey,
    messageId: string,
  ): PublicKey {
    return super.derivePda(
      ['hyperlane', '-', 'processed_message', Buffer.from(messageId, 'hex')],
      mailboxProgramId,
    );
  }
}

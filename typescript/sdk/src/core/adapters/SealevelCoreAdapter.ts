import { PublicKey } from '@solana/web3.js';

import {
  Address,
  HexString,
  ensure0x,
  pollAsync,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

// https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/mailbox/src/processor.rs
const MESSAGE_DISPATCH_LOG_REGEX = /Dispatched message to (.*), ID (.*)/;

export class SealevelCoreAdapter
  extends BaseSealevelAdapter
  implements ICoreAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: HexString; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.SolanaWeb3) {
      throw new Error(
        `Unsupported provider type for SealevelCoreAdapter ${sourceTx.type}`,
      );
    }
    const logs = sourceTx.receipt.meta?.logMessages;
    if (!logs)
      throw new Error('Transaction logs required to check message delivery');
    const parsedLogs = SealevelCoreAdapter.parseMessageDispatchLogs(logs);
    return parsedLogs.map(({ destination, messageId }) => ({
      messageId: ensure0x(messageId),
      destination: this.multiProvider.getChainName(destination),
    }));
  }

  async waitForMessageProcessed(
    messageId: string,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean> {
    const pda = SealevelCoreAdapter.deriveMailboxMessageProcessedPda(
      this.addresses.mailbox,
      messageId,
    );
    const connection = this.multiProvider.getSolanaWeb3Provider(destination);

    await pollAsync(
      async () => {
        // If the PDA exists, then the message has been processed
        // Checking existence by checking for account info
        const accountInfo = await connection.getAccountInfo(pda);
        if (accountInfo?.data?.length) return;
        else throw new Error(`Message ${messageId} not yet processed`);
      },
      delayMs,
      maxAttempts,
    );

    return true;
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
    messageId: HexString,
  ): PublicKey {
    return super.derivePda(
      [
        'hyperlane',
        '-',
        'processed_message',
        '-',
        Buffer.from(strip0x(messageId), 'hex'),
      ],
      mailboxProgramId,
    );
  }
}

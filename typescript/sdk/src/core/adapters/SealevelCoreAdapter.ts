import { PublicKey } from '@solana/web3.js';

import { pollAsync } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType';
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
  async waitForMessageProcessed(
    sourceTx: TypedTransactionReceipt,
    delay?: number,
    maxAttempts?: number,
  ): Promise<void> {
    if (sourceTx.type !== ProviderType.SolanaWeb3) {
      throw new Error(
        `Unsupported provider type for SealevelCoreAdapter ${sourceTx.type}`,
      );
    }
    const receipt = sourceTx.receipt;
    const logs = receipt.meta?.logMessages;
    if (!logs)
      throw new Error('Transaction logs required to check message delivery');
    const parsedLog = SealevelCoreAdapter.parseMessageDispatchLog(logs);
    if (!parsedLog) throw new Error('Message dispatch log not found');
    const { destination, messageId } = parsedLog;
    const destinationMailbox =
      this.multiProvider.getChainMetadata(destination).mailbox;
    const pda = SealevelCoreAdapter.deriveMailboxMessageProcessedPda(
      messageId,
      destinationMailbox,
    );
    const connection = this.multiProvider.getSolanaWeb3Provider(destination);

    await pollAsync(
      async () => {
        // If the PDA exists, then the message has been processed
        // Checking existence by querying for balance
        await connection.getBalance(pda);
        return;
      },
      delay,
      maxAttempts,
    );
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/mailbox/src/pda_seeds.rs
  static deriveMailboxMessageProcessedPda(
    messageId: string,
    mailboxProgramId: string,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('hyperlane'),
        Buffer.from('-'),
        Buffer.from('processed_message'),
        Buffer.from('-'),
        Buffer.from(messageId, 'hex'),
      ],
      new PublicKey(mailboxProgramId),
    );
    return pda;
  }

  static parseMessageDispatchLog(
    logs: string[],
  ): { destination: string; messageId: string } | undefined {
    for (const log of logs) {
      if (!MESSAGE_DISPATCH_LOG_REGEX.test(log)) continue;
      const [, destination, messageId] = MESSAGE_DISPATCH_LOG_REGEX.exec(log)!;
      if (destination && messageId) return { destination, messageId };
    }
    return undefined;
  }
}

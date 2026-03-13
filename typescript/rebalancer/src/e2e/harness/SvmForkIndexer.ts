import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';

import { SealevelCoreAdapter } from '@hyperlane-xyz/sdk';
import { bytes32ToAddress, parseMessage } from '@hyperlane-xyz/utils';

import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { ExplorerMessage } from '../../utils/ExplorerClient.js';
import type { IForkIndexer } from './IForkIndexer.js';
import { extractRawMessage } from './SvmMessageParser.js';

const SVM_DOMAIN_ID = 13375;

export class SvmForkIndexer implements IForkIndexer {
  private lastScannedSlot: number = 0;
  private seenMessageIds: Set<string> = new Set();
  private initialized: boolean = false;
  private userTransfers: ExplorerMessage[] = [];
  private rebalanceActions: ExplorerMessage[] = [];
  private lastSignature?: string;

  constructor(
    private readonly connection: Connection,
    private readonly mailboxProgramId: PublicKey,
    private readonly svmChainName: string,
    private readonly rebalancerAddresses: string[],
    private readonly logger: Logger,
  ) {}

  getUserTransfers(): ExplorerMessage[] {
    return this.userTransfers;
  }

  getRebalanceActions(): ExplorerMessage[] {
    return this.rebalanceActions;
  }

  async initialize(confirmedBlockTags: ConfirmedBlockTags): Promise<void> {
    const confirmedSlot = confirmedBlockTags[this.svmChainName];
    if (typeof confirmedSlot !== 'number') {
      throw new Error(
        `Missing confirmed block tag for chain ${this.svmChainName}`,
      );
    }

    this.lastScannedSlot = confirmedSlot;
    this.initialized = true;
  }

  async sync(confirmedBlockTags: ConfirmedBlockTags): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const confirmedSlot = confirmedBlockTags[this.svmChainName];
    if (typeof confirmedSlot !== 'number') {
      throw new Error(
        `Missing confirmed block tag for chain ${this.svmChainName}`,
      );
    }

    const currentSlot = confirmedSlot;
    if (this.lastScannedSlot >= currentSlot) {
      return;
    }

    const signatures = await this.connection.getSignaturesForAddress(
      this.mailboxProgramId,
      {
        until: this.lastSignature,
        limit: 1000,
      },
    );

    const signaturesOldestFirst = [...signatures].reverse();
    for (const signatureInfo of signaturesOldestFirst) {
      const signature = signatureInfo.signature;
      const tx = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        continue;
      }

      const logMessages = tx.meta?.logMessages ?? [];
      const dispatches =
        SealevelCoreAdapter.parseMessageDispatchLogs(logMessages);
      if (!dispatches.length) {
        continue;
      }

      const senderAddress =
        ('accountKeys' in tx.transaction.message
          ? tx.transaction.message.accountKeys[0]
          : tx.transaction.message.staticAccountKeys[0]
        )?.toString() ?? '';

      for (const { destination, messageId: msgId } of dispatches) {
        if (this.seenMessageIds.has(msgId)) {
          continue;
        }

        const destinationDomain = Number(destination);
        if (!Number.isFinite(destinationDomain)) {
          this.logger.debug(
            { destination, msgId, signature },
            'Skipping dispatch with invalid destination domain',
          );
          continue;
        }

        const msg: ExplorerMessage = {
          msg_id: msgId,
          origin_domain_id: SVM_DOMAIN_ID,
          destination_domain_id: destinationDomain,
          sender: senderAddress,
          recipient: '',
          origin_tx_hash: signature,
          origin_tx_sender: senderAddress,
          origin_tx_recipient: '',
          is_delivered: false,
          message_body: '',
          send_occurred_at: null,
        };

        const rawMessage = await extractRawMessage(
          this.connection,
          this.mailboxProgramId,
          tx,
          msgId,
          destinationDomain,
        );
        if (rawMessage) {
          const parsed = parseMessage(rawMessage);
          msg.recipient = bytes32ToAddress(parsed.recipient);
          msg.message_body = parsed.body;
        } else {
          this.logger.warn(
            { msgId, signature },
            'Could not extract raw message from PDA; recipient and message_body will be empty',
          );
        }

        if (
          this.rebalancerAddresses.some(
            (addr) => senderAddress.toLowerCase() === addr.toLowerCase(),
          )
        ) {
          this.rebalanceActions.push(msg);
        } else {
          this.userTransfers.push(msg);
        }

        this.seenMessageIds.add(msgId);
      }
    }

    if (signatures.length > 0) {
      this.lastSignature = signatures[0].signature;
    }
    this.lastScannedSlot = currentSlot;
  }
}

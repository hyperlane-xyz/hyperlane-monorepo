import type { Logger } from 'pino';

import { HyperlaneCore, type MultiProvider } from '@hyperlane-xyz/sdk';
import { bytes32ToAddress, messageId, parseMessage } from '@hyperlane-xyz/utils';

import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { ExplorerMessage } from '../../utils/ExplorerClient.js';

type EvmProvider = ReturnType<MultiProvider['getProvider']>;
type DispatchEvent = {
  args?: {
    sender?: unknown;
    message?: unknown;
  };
  transactionHash?: unknown;
  log?: {
    transactionHash?: unknown;
  };
};

export class ForkIndexer {
  private lastScannedBlock: Map<string, number> = new Map();
  private seenMessageIds: Set<string> = new Set();
  private initialized: boolean = false;
  private userTransfers: ExplorerMessage[] = [];
  private rebalanceActions: ExplorerMessage[] = [];

  constructor(
    private readonly providers: Map<string, EvmProvider>,
    private readonly core: HyperlaneCore,
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
    for (const [chain] of this.providers) {
      const blockNumber = confirmedBlockTags[chain];
      if (blockNumber === undefined) {
        throw new Error(`Missing confirmed block tag for chain ${chain}`);
      }
      this.lastScannedBlock.set(chain, blockNumber as number);
      this.logger.debug(
        { chain, blockNumber },
        'ForkIndexer initialized lastScannedBlock',
      );
    }
    this.initialized = true;
  }

  async sync(confirmedBlockTags: ConfirmedBlockTags): Promise<void> {
    if (!this.initialized) {
      return; // No-op: nothing to scan yet
    }

    for (const [chain, provider] of this.providers) {
      const currentBlock = confirmedBlockTags[chain];
      if (currentBlock === undefined) {
        throw new Error(`Missing confirmed block tag for chain ${chain}`);
      }
      const lastBlock = this.lastScannedBlock.get(chain) ?? 0;
      const currentBlockNumber = currentBlock as number;

      this.logger.debug(
        {
          chain,
          lastBlock,
          currentBlock: currentBlockNumber,
          skip: lastBlock >= currentBlockNumber,
        },
        'ForkIndexer sync check',
      );

      if (lastBlock >= currentBlockNumber) {
        continue;
      }

      const mailbox = this.core.getContracts(chain).mailbox;
      const events = await mailbox.queryFilter(
        mailbox.filters.Dispatch(),
        lastBlock + 1,
        currentBlockNumber,
      );

      this.logger.debug(
        {
          chain,
          eventCount: events.length,
          fromBlock: lastBlock + 1,
          toBlock: currentBlockNumber,
        },
        'Scanned Dispatch events',
      );

      for (const event of events) {
        const dispatchEvent = event as DispatchEvent;
        const sender = dispatchEvent.args?.sender;
        const message = dispatchEvent.args?.message;
        if (typeof sender !== 'string' || typeof message !== 'string') {
          this.logger.warn(
            { chain, event },
            'Skipping malformed Dispatch event',
          );
          continue;
        }

        const parsed = parseMessage(message);

        const destChain = this.core.multiProvider.tryGetChainName(
          parsed.destination,
        );
        if (!destChain) {
          continue;
        }

        const txHash = this.getTransactionHash(dispatchEvent);
        if (!txHash) {
          this.logger.warn({ chain, event }, 'Dispatch event missing tx hash');
          continue;
        }

        const receipt = await provider.getTransactionReceipt(txHash);
        const msgId = messageId(message);

        if (this.seenMessageIds.has(msgId)) {
          continue;
        }

        const msg: ExplorerMessage = {
          msg_id: msgId,
          origin_domain_id: parsed.origin,
          destination_domain_id: parsed.destination,
          sender: bytes32ToAddress(parsed.sender),
          recipient: bytes32ToAddress(parsed.recipient),
          origin_tx_hash: receipt.transactionHash,
          origin_tx_sender: receipt.from,
          origin_tx_recipient: sender,
          is_delivered: false,
          message_body: parsed.body,
          send_occurred_at: null,
        };

        if (
          this.rebalancerAddresses.some(
            (addr) => receipt.from.toLowerCase() === addr.toLowerCase(),
          )
        ) {
          this.rebalanceActions.push(msg);
        } else {
          this.userTransfers.push(msg);
        }

        this.seenMessageIds.add(msgId);
      }

      this.lastScannedBlock.set(chain, currentBlockNumber);
    }
  }

  private getTransactionHash(event: DispatchEvent): string | undefined {
    if (typeof event.transactionHash === 'string') {
      return event.transactionHash;
    }
    if (typeof event.log?.transactionHash === 'string') {
      return event.log.transactionHash;
    }
    return undefined;
  }
}

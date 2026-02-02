import { providers } from 'ethers';
import type { Logger } from 'pino';

import { HyperlaneCore } from '@hyperlane-xyz/sdk';
import {
  bytes32ToAddress,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { ExplorerMessage } from '../../utils/ExplorerClient.js';

import type { MockExplorerClient } from './MockExplorerClient.js';

export class ForkIndexer {
  private lastScannedBlock: Map<string, number> = new Map();
  private seenMessageIds: Set<string> = new Set();
  private initialized: boolean = false;

  constructor(
    private readonly providers: Map<string, providers.JsonRpcProvider>,
    private readonly core: HyperlaneCore,
    private readonly mockExplorer: MockExplorerClient,
    private readonly rebalancerAddresses: string[],
    private readonly logger: Logger,
  ) {}

  async initialize(confirmedBlockTags: ConfirmedBlockTags): Promise<void> {
    for (const [chain] of this.providers) {
      const blockNumber = confirmedBlockTags[chain];
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
      throw new Error('ForkIndexer not initialized. Call initialize() first.');
    }

    for (const [chain] of this.providers) {
      const currentBlock = confirmedBlockTags[chain] as number;
      const lastBlock = this.lastScannedBlock.get(chain) ?? 0;

      this.logger.debug(
        { chain, lastBlock, currentBlock, skip: lastBlock >= currentBlock },
        'ForkIndexer sync check',
      );

      if (lastBlock >= currentBlock) {
        continue;
      }

      const mailbox = this.core.getContracts(chain).mailbox;
      const events = await mailbox.queryFilter(
        mailbox.filters.Dispatch(),
        lastBlock + 1,
        currentBlock,
      );

      this.logger.debug(
        {
          chain,
          eventCount: events.length,
          fromBlock: lastBlock + 1,
          toBlock: currentBlock,
        },
        'Scanned Dispatch events',
      );

      for (const event of events) {
        const parsed = parseMessage(event.args.message);

        const destChain = this.core.multiProvider.tryGetChainName(
          parsed.destination,
        );
        if (!destChain) {
          continue;
        }

        const receipt = await event.getTransactionReceipt();
        const msgId = messageId(event.args.message);

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
          origin_tx_recipient: event.args.sender,
          is_delivered: false,
          message_body: parsed.body,
        };

        if (
          this.rebalancerAddresses.some(
            (addr) => receipt.from.toLowerCase() === addr.toLowerCase(),
          )
        ) {
          this.mockExplorer.addRebalanceAction(msg);
        } else {
          this.mockExplorer.addUserTransfer(msg);
        }

        this.seenMessageIds.add(msgId);
      }

      this.lastScannedBlock.set(chain, currentBlock);
    }
  }
}

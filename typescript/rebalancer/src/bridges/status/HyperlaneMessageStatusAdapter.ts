import type { Logger } from 'pino';

import { HyperlaneCore } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { TokenBridgeStatusAdapterType } from '../../config/types.js';
import type {
  ITokenBridgeStatusAdapter,
  MCRExecutionContext,
  MCRSettlementStatus,
  MCRStatusPollContext,
  MCRStatusRef,
} from '../../interfaces/ITokenBridgeStatusAdapter.js';

interface HyperlaneMessageRefData extends Record<string, unknown> {
  messageId: string;
}

/** Default settlement adapter for bridges that dispatch Hyperlane messages. */
export class HyperlaneMessageStatusAdapter implements ITokenBridgeStatusAdapter {
  readonly kind = TokenBridgeStatusAdapterType.HyperlaneMessage;

  constructor(readonly logger: Logger) {}

  async initFromReceipt(
    ctx: MCRExecutionContext,
  ): Promise<MCRStatusRef | null> {
    const dispatchedMessages = HyperlaneCore.getDispatchedMessages(ctx.receipt);
    if (dispatchedMessages.length === 0) {
      this.logger.error(
        {
          origin: ctx.origin,
          destination: ctx.destination,
          bridge: ctx.bridge,
          txHash: ctx.receipt.transactionHash,
        },
        'No Dispatch event found in confirmed rebalance receipt',
      );
      return null;
    }

    if (dispatchedMessages.length > 1) {
      this.logger.warn(
        {
          messageCount: dispatchedMessages.length,
          txHash: ctx.receipt.transactionHash,
        },
        'Multiple Dispatch events found in rebalance receipt; using first',
      );
    }

    const data: HyperlaneMessageRefData = {
      messageId: dispatchedMessages[0].id,
    };
    return { provider: this.kind, kind: this.kind, data };
  }

  async pollStatus(
    ref: MCRStatusRef,
    ctx: MCRStatusPollContext,
  ): Promise<MCRSettlementStatus> {
    const { messageId } = ref.data;
    assert(
      typeof messageId === 'string',
      'Hyperlane settlement ref is missing messageId',
    );

    try {
      const chainName = ctx.core.multiProvider.getChainName(ctx.destination);
      const delivered = await ctx.core
        .adapter(chainName)
        .isDelivered(messageId, ctx.blockTag);
      return { status: delivered ? 'complete' : 'pending', ref };
    } catch (error) {
      this.logger.warn(
        { messageId, destination: ctx.destination, error },
        'Failed to check Hyperlane message delivery status',
      );
      return { status: 'pending', ref };
    }
  }
}

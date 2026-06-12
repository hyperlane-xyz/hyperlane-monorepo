import { type providers } from 'ethers';
import { type Logger } from 'pino';

import { HyperlaneCore, type MultiProvider } from '@hyperlane-xyz/sdk';

import type {
  MovableCollateralExecutionResult,
  PreparedTransaction,
} from '../../interfaces/IRebalancer.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import { normalizeToCanonical } from '../../utils/balanceUtils.js';
import type { MovableInternalExecutionResult } from './types.js';

export class MovableResultRecorder {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly actionTracker: IActionTracker,
    private readonly logger: Logger,
  ) {}

  async recordResults(
    results: MovableInternalExecutionResult[],
  ): Promise<void> {
    for (const result of results) {
      const intentId = result.intentId;

      if (result.success && result.messageId) {
        await this.actionTracker.createRebalanceAction({
          intentId,
          origin: this.multiProvider.getDomainId(result.route.origin),
          destination: this.multiProvider.getDomainId(result.route.destination),
          amount: result.canonicalAmount ?? result.route.amount,
          type: 'rebalance_message',
          messageId: result.messageId,
          txHash: result.txHash,
        });

        this.logger.info(
          {
            intentId,
            messageId: result.messageId,
            txHash: result.txHash,
            origin: result.route.origin,
            destination: result.route.destination,
          },
          'Rebalance action created successfully',
        );
      } else {
        await this.actionTracker.failRebalanceIntent(intentId);

        this.logger.warn(
          {
            intentId,
            success: result.success,
            error: result.error,
            origin: result.route.origin,
            destination: result.route.destination,
          },
          'Rebalance intent marked as failed',
        );
      }
    }
  }

  toPublicResults(
    internalResults: MovableInternalExecutionResult[],
  ): MovableCollateralExecutionResult[] {
    return internalResults.map((internal) => ({
      route: internal.route,
      success: internal.success,
      error: internal.error,
      messageId: internal.messageId || '',
      txHash: internal.txHash,
    }));
  }

  buildResult(
    transaction: PreparedTransaction,
    receipt: providers.TransactionReceipt,
  ): MovableInternalExecutionResult {
    const { origin, destination } = transaction.route;
    const dispatchedMessages = HyperlaneCore.getDispatchedMessages(receipt);

    if (dispatchedMessages.length === 0) {
      this.logger.error(
        { origin, destination, txHash: receipt.transactionHash },
        'No Dispatch event found in confirmed rebalance receipt',
      );
      return {
        route: transaction.route,
        intentId: transaction.route.intentId,
        success: false,
        error: `Transaction confirmed but no Dispatch event found`,
        messageId: '',
        txHash: receipt.transactionHash,
      };
    }

    return {
      route: transaction.route,
      intentId: transaction.route.intentId,
      success: true,
      messageId: dispatchedMessages[0].id,
      txHash: receipt.transactionHash,
      canonicalAmount: normalizeToCanonical(
        transaction.originTokenAmount.amount,
        transaction.originTokenAmount.token,
      ),
      localAmount: transaction.originTokenAmount.amount,
    };
  }
}

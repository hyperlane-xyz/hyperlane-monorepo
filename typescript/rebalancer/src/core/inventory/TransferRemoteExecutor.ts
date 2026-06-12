import type { Logger } from 'pino';

import {
  type ChainName,
  type MultiProvider,
  type Token,
  type WarpTypedTransaction,
  type WarpCore,
  WarpTxCategory,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import type { InventoryExecutionResult } from '../../interfaces/IRebalancer.js';
import type { InventoryRoute } from '../../interfaces/IStrategy.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { RebalanceIntent } from '../../tracking/types.js';

export class TransferRemoteExecutor {
  constructor(
    private readonly actionTracker: IActionTracker,
    private readonly warpCore: WarpCore,
    private readonly multiProvider: MultiProvider,
    private readonly getTokenForChain: (chain: ChainName) => Token | undefined,
    private readonly getInventorySignerAddress: (chain: ChainName) => string,
    private readonly sendAndConfirmInventoryTx: (
      chain: ChainName,
      typedTx: WarpTypedTransaction,
    ) => Promise<{ txHash: string }>,
    private readonly extractDispatchedMessageId: (
      origin: ChainName,
      txHash: string,
    ) => Promise<string | undefined>,
    private readonly logger: Logger,
  ) {}

  async executeTransferRemote(
    route: InventoryRoute,
    intent: RebalanceIntent,
    fulfilledCanonicalAmount: bigint,
  ): Promise<InventoryExecutionResult> {
    const { origin, destination, amount } = route;

    const originToken = this.getTokenForChain(origin);
    if (!originToken) {
      throw new Error(`No token found for origin chain: ${origin}`);
    }

    const destinationDomain = this.multiProvider.getDomainId(destination);

    this.logger.debug(
      { origin, destination, amount: amount.toString() },
      'Building transferRemote transactions for exact execution amount',
    );

    const originTokenAmount = originToken.amount(amount);
    const transferTxs = await this.warpCore.getTransferRemoteTxs({
      originTokenAmount,
      destination,
      sender: this.getInventorySignerAddress(origin),
      recipient: this.getInventorySignerAddress(destination),
    });
    assert(
      transferTxs.length > 0,
      'Expected at least one transaction from WarpCore',
    );

    this.logger.info(
      {
        origin,
        destination,
        amount: amount.toString(),
        transactionCount: transferTxs.length,
        intentId: intent.id,
      },
      'Sending transferRemote transactions',
    );

    let transferTxHash: string | undefined;
    for (const tx of transferTxs) {
      const { txHash } = await this.sendAndConfirmInventoryTx(origin, tx);
      if (tx.category === WarpTxCategory.Transfer) {
        transferTxHash = txHash;
      }
    }

    const messageId = transferTxHash
      ? await this.extractDispatchedMessageId(origin, transferTxHash)
      : undefined;

    assert(transferTxHash, 'No transfer transaction hash found');

    if (!messageId) {
      this.logger.warn(
        {
          origin,
          destination,
          txHash: transferTxHash,
          intentId: intent.id,
        },
        'TransferRemote transaction sent but no messageId found in logs',
      );
    }

    this.logger.info(
      {
        origin,
        destination,
        txHash: transferTxHash,
        messageId,
        intentId: intent.id,
      },
      'TransferRemote transaction confirmed',
    );

    await this.actionTracker.createRebalanceAction({
      intentId: intent.id,
      origin: this.multiProvider.getDomainId(origin),
      destination: destinationDomain,
      amount: fulfilledCanonicalAmount,
      type: 'inventory_deposit',
      txHash: transferTxHash,
      messageId,
    });

    return {
      route,
      success: true,
      amountSent: amount,
    };
  }
}

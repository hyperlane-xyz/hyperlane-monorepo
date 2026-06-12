import { type providers } from 'ethers';
import { type Logger } from 'pino';

import {
  type ChainName,
  type EthJsonRpcBlockParameterTag,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';

import type { PreparedTransaction } from '../../interfaces/IRebalancer.js';
import type { Metrics } from '../../metrics/Metrics.js';
import { MovableResultRecorder } from './ResultRecorder.js';
import type { MovableInternalExecutionResult } from './types.js';

type ChainSendResult =
  | {
      transaction: PreparedTransaction;
      receipt: providers.TransactionReceipt;
    }
  | { transaction: PreparedTransaction; error: string };

export class MovableChainTransactionExecutor {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly resultRecorder: MovableResultRecorder,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
  ) {}

  async executeTransactions(
    transactions: PreparedTransaction[],
  ): Promise<MovableInternalExecutionResult[]> {
    this.logger.info(
      { numTransactions: transactions.length },
      'Estimating gas for all prepared transactions.',
    );

    const results: MovableInternalExecutionResult[] = [];

    const gasEstimateResults = await Promise.allSettled(
      transactions.map(async (transaction) => {
        await this.multiProvider.estimateGas(
          transaction.route.origin,
          transaction.populatedTx,
        );
        return transaction;
      }),
    );

    const validTransactions: PreparedTransaction[] = [];
    gasEstimateResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        validTransactions.push(result.value);
      } else {
        const failedTransaction = transactions[i];
        this.logger.error(
          {
            origin: failedTransaction.route.origin,
            destination: failedTransaction.route.destination,
            amount:
              failedTransaction.originTokenAmount.getDecimalFormattedAmount(),
            tokenName: failedTransaction.originTokenAmount.token.name,
            error: result.reason,
          },
          'Gas estimation failed for route.',
        );
        results.push({
          route: failedTransaction.route,
          intentId: failedTransaction.route.intentId,
          success: false,
          error: `Gas estimation failed: ${String(result.reason)}`,
          messageId: '',
        });
      }
    });

    if (validTransactions.length === 0) {
      this.logger.info('No transactions to execute after gas estimation.');
      return results;
    }

    const txsByOrigin = new Map<ChainName, PreparedTransaction[]>();
    for (const tx of validTransactions) {
      const origin = tx.route.origin;
      const chainTransactions = txsByOrigin.get(origin) ?? [];
      chainTransactions.push(tx);
      txsByOrigin.set(origin, chainTransactions);
    }

    this.logger.info(
      {
        numChains: txsByOrigin.size,
        numTransactions: validTransactions.length,
      },
      'Sending transactions (parallel across chains, sequential within chain).',
    );

    const chainSendResults = await Promise.allSettled(
      Array.from(txsByOrigin.entries()).map(([origin, txs]) =>
        this.sendTransactionsForChain(origin, txs),
      ),
    );

    const successfulSends: Array<{
      transaction: PreparedTransaction;
      receipt: providers.TransactionReceipt;
    }> = [];

    chainSendResults.forEach((chainResult) => {
      if (chainResult.status === 'fulfilled') {
        for (const txResult of chainResult.value) {
          if ('receipt' in txResult) {
            successfulSends.push(txResult);
          } else {
            results.push({
              route: txResult.transaction.route,
              intentId: txResult.transaction.route.intentId,
              success: false,
              error: `Transaction send failed: ${txResult.error}`,
              messageId: '',
            });
            this.metrics?.recordActionAttempt(
              txResult.transaction.route,
              false,
            );
          }
        }
      } else {
        this.logger.error(
          { error: chainResult.reason },
          'Unexpected error during chain transaction sending.',
        );
      }
    });

    for (const { transaction, receipt } of successfulSends) {
      const result = this.resultRecorder.buildResult(transaction, receipt);
      results.push(result);
      this.metrics?.recordActionAttempt(result.route, result.success);
    }

    return results;
  }

  async sendTransactionsForChain(
    origin: ChainName,
    transactions: PreparedTransaction[],
  ): Promise<ChainSendResult[]> {
    const results: ChainSendResult[] = [];

    for (const transaction of transactions) {
      try {
        const decimalFormattedAmount =
          transaction.originTokenAmount.getDecimalFormattedAmount();
        const tokenName = transaction.originTokenAmount.token.name;
        const reorgPeriod = this.getReorgPeriod(origin);

        this.logger.info(
          {
            origin,
            destination: transaction.route.destination,
            amount: decimalFormattedAmount,
            tokenName,
            reorgPeriod,
          },
          'Sending rebalance transaction and waiting for reorgPeriod confirmations.',
        );

        const receipt = await this.multiProvider.sendTransaction(
          origin,
          transaction.populatedTx,
          {
            waitConfirmations: reorgPeriod as
              | number
              | EthJsonRpcBlockParameterTag,
          },
        );

        this.logger.info(
          {
            origin,
            destination: transaction.route.destination,
            amount: decimalFormattedAmount,
            tokenName,
            txHash: receipt.transactionHash,
          },
          'Rebalance transaction confirmed at reorgPeriod depth.',
        );

        results.push({ transaction, receipt });
      } catch (error) {
        this.logger.error(
          {
            origin,
            destination: transaction.route.destination,
            amount: transaction.originTokenAmount.getDecimalFormattedAmount(),
            tokenName: transaction.originTokenAmount.token.name,
            error,
          },
          'Transaction send failed for route.',
        );
        results.push({ transaction, error: String(error) });
      }
    }

    return results;
  }

  private getReorgPeriod(chainName: string): number | string {
    const metadata = this.multiProvider.getChainMetadata(chainName);
    return metadata.blocks?.reorgPeriod ?? 32;
  }
}

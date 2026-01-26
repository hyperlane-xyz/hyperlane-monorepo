import { type PopulatedTransaction, type providers } from 'ethers';
import { type Logger } from 'pino';

import {
  type ChainMap,
  type ChainMetadata,
  type ChainName,
  type EthJsonRpcBlockParameterTag,
  EvmMovableCollateralAdapter,
  HyperlaneCore,
  type InterchainGasQuote,
  type MultiProvider,
  type Token,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import {
  eqAddress,
  isNullish,
  mapAllSettled,
  toWei,
} from '@hyperlane-xyz/utils';

import type {
  IRebalancer,
  PreparedTransaction,
  RebalanceExecutionResult,
} from '../interfaces/IRebalancer.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';
import { type Metrics } from '../metrics/Metrics.js';
import {
  type BridgeConfigWithOverride,
  getBridgeConfig,
} from '../utils/index.js';

export class Rebalancer implements IRebalancer {
  private readonly logger: Logger;
  constructor(
    private readonly bridges: ChainMap<BridgeConfigWithOverride>,
    private readonly warpCore: WarpCore,
    private readonly chainMetadata: ChainMap<ChainMetadata>,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
    logger: Logger,
    private readonly metrics?: Metrics,
  ) {
    this.logger = logger.child({ class: Rebalancer.name });
  }

  async rebalance(
    routes: RebalancingRoute[],
  ): Promise<RebalanceExecutionResult[]> {
    if (routes.length === 0) {
      this.logger.info('No routes to execute, exiting');
      return [];
    }

    this.logger.info({ numberOfRoutes: routes.length }, 'Rebalance initiated');

    const { preparedTransactions, preparationFailureResults } =
      await this.prepareTransactions(routes);

    let executionResults: RebalanceExecutionResult[] = [];

    if (preparedTransactions.length > 0) {
      const filteredTransactions =
        this.filterTransactions(preparedTransactions);
      if (filteredTransactions.length > 0) {
        executionResults = await this.executeTransactions(filteredTransactions);
      }
    }

    // Combine preparation failures with execution results
    const allResults = [...preparationFailureResults, ...executionResults];

    // Record metrics for successful transactions
    const successfulResults = allResults.filter((r) => r.success);
    if (this.metrics && successfulResults.length > 0) {
      for (const result of successfulResults) {
        const token = this.tokensByChainName[result.route.origin];
        if (token) {
          this.metrics.recordRebalanceAmount(
            result.route,
            token.amount(result.route.amount),
          );
        }
      }
    }

    const failures = allResults.filter((r) => !r.success);
    if (failures.length > 0) {
      this.logger.error(
        { failureCount: failures.length, totalRoutes: routes.length },
        'Some rebalance operations failed.',
      );
    } else {
      this.logger.info('✅ Rebalance successful');
    }

    return allResults;
  }

  private async prepareTransactions(routes: RebalancingRoute[]): Promise<{
    preparedTransactions: PreparedTransaction[];
    preparationFailureResults: RebalanceExecutionResult[];
  }> {
    this.logger.info(
      { numRoutes: routes.length },
      'Preparing all rebalance transactions.',
    );
    const { fulfilled, rejected } = await mapAllSettled(
      routes,
      (route) => this.prepareTransaction(route),
      (_, i) => i,
    );

    // Filter out null results (validation failures logged internally)
    const preparedTransactions = Array.from(fulfilled.values()).filter(
      (tx): tx is PreparedTransaction => !isNullish(tx),
    );

    // Create failure results for tracking
    const preparationFailureResults: RebalanceExecutionResult[] = [];
    for (const [i, error] of rejected) {
      preparationFailureResults.push({
        route: routes[i],
        success: false,
        error: String(error),
      });
    }
    // Also track null results (validation failures)
    Array.from(fulfilled.entries()).forEach(([i, tx]) => {
      if (isNullish(tx)) {
        preparationFailureResults.push({
          route: routes[i],
          success: false,
          error: 'Preparation returned null',
        });
      }
    });

    return { preparedTransactions, preparationFailureResults };
  }

  private async prepareTransaction(
    route: RebalancingRoute,
  ): Promise<PreparedTransaction | null> {
    const { origin, destination, amount } = route;

    this.logger.info(
      {
        origin,
        destination,
        amount,
      },
      'Preparing transaction for route',
    );

    // 1. Adapter and permissions validation
    if (!(await this.validateRoute(route))) {
      // Errors logged in validateRoute
      return null;
    }

    const originToken = this.tokensByChainName[origin];
    const destinationToken = this.tokensByChainName[destination];
    const destinationChainMeta = this.chainMetadata[destination];

    const originTokenAmount = originToken.amount(amount);
    const decimalFormattedAmount =
      originTokenAmount.getDecimalFormattedAmount();
    const originHypAdapter = originToken.getHypAdapter(
      this.warpCore.multiProvider,
    ) as EvmMovableCollateralAdapter;
    const { bridge, bridgeIsWarp } = getBridgeConfig(
      this.bridges,
      origin,
      destination,
      this.logger,
    );

    // 2. Get quotes
    let quotes: InterchainGasQuote[];
    try {
      quotes = await originHypAdapter.getRebalanceQuotes(
        bridge,
        destinationChainMeta.domainId,
        destinationToken.addressOrDenom,
        amount,
        bridgeIsWarp,
      );
    } catch (error) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          error,
        },
        'Failed to get quotes for route.',
      );
      return null;
    }

    // 3. Populate transaction
    let populatedTx: PopulatedTransaction;
    try {
      populatedTx = await originHypAdapter.populateRebalanceTx(
        destinationChainMeta.domainId,
        amount,
        bridge,
        quotes,
      );
    } catch (error) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          error,
        },
        'Failed to populate transaction for route.',
      );
      return null;
    }

    return { populatedTx, route, originTokenAmount };
  }

  private async validateRoute(route: RebalancingRoute): Promise<boolean> {
    const { origin, destination, amount } = route;
    const originToken = this.tokensByChainName[origin];
    const destinationToken = this.tokensByChainName[destination];
    const destinationDomain = this.chainMetadata[destination];

    if (!originToken) {
      this.logger.error(
        { origin, destination, amount },
        'Route validation failed: origin token not found.',
      );
      return false;
    }

    const originTokenAmount = originToken.amount(amount);
    const decimalFormattedAmount =
      originTokenAmount.getDecimalFormattedAmount();

    if (!destinationToken) {
      this.logger.error(
        { origin, destination, amount: decimalFormattedAmount },
        'Route validation failed: destination token not found.',
      );
      return false;
    }

    if (!destinationDomain) {
      this.logger.error(
        { origin, destination, amount: decimalFormattedAmount },
        'Route validation failed: destination domain metadata not found.',
      );
      return false;
    }

    const originHypAdapter = originToken.getHypAdapter(
      this.warpCore.multiProvider,
    );
    if (!(originHypAdapter instanceof EvmMovableCollateralAdapter)) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
        },
        'Route validation failed: Origin TokenAdapter is not an EvmHypCollateralAdapter.',
      );
      return false;
    }

    const signer = this.multiProvider.getSigner(origin);
    const signerAddress = await signer.getAddress();
    if (!(await originHypAdapter.isRebalancer(signerAddress))) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          tokenAddress: originToken.addressOrDenom,
          signerAddress,
        },
        'Route validation failed: Signer is not a rebalancer.',
      );
      return false;
    }

    const allowedDestination = await originHypAdapter.getAllowedDestination(
      destinationDomain.domainId,
    );
    if (!eqAddress(allowedDestination, destinationToken.addressOrDenom)) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          tokenAddress: originToken.addressOrDenom,
          destinationTokenAddress: destinationToken.addressOrDenom,
          allowedDestinationTokenAddress: allowedDestination,
        },
        'Route validation failed: Destination is not allowed.',
      );
      return false;
    }

    const { bridge } = getBridgeConfig(
      this.bridges,
      origin,
      destination,
      this.logger,
    );
    if (
      !(await originHypAdapter.isBridgeAllowed(
        destinationDomain.domainId,
        bridge,
      ))
    ) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          tokenAddress: originToken.addressOrDenom,
          bridgeAddress: bridge,
        },
        'Route validation failed: Bridge is not allowed.',
      );
      return false;
    }

    return true;
  }

  private async executeTransactions(
    transactions: PreparedTransaction[],
  ): Promise<RebalanceExecutionResult[]> {
    this.logger.info(
      { numTransactions: transactions.length },
      'Estimating gas for all prepared transactions.',
    );

    const results: RebalanceExecutionResult[] = [];

    // 1. Estimate gas for rebalance transactions
    const gasEstimateResults = await Promise.allSettled(
      transactions.map(async (transaction) => {
        await this.multiProvider.estimateGas(
          transaction.route.origin,
          transaction.populatedTx,
        );
        return transaction;
      }),
    );

    // 2. Filter out failed transactions and track failures
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
          success: false,
          error: `Gas estimation failed: ${String(result.reason)}`,
        });
      }
    });

    if (validTransactions.length === 0) {
      this.logger.info('No transactions to execute after gas estimation.');
      return results;
    }

    // 3. Group transactions by origin chain
    const txsByOrigin = new Map<ChainName, PreparedTransaction[]>();
    for (const tx of validTransactions) {
      const origin = tx.route.origin;
      if (!txsByOrigin.has(origin)) {
        txsByOrigin.set(origin, []);
      }
      txsByOrigin.get(origin)!.push(tx);
    }

    // 4. Send transactions - parallel across chains, sequential within each chain
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

    // 5. Collect successful sends and record send failures
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
              success: false,
              error: `Transaction send failed: ${txResult.error}`,
            });
            this.metrics?.recordActionAttempt(
              txResult.transaction.route,
              false,
            );
          }
        }
      } else {
        // This shouldn't happen since sendTransactionsForChain catches errors internally,
        // but handle it just in case
        this.logger.error(
          { error: chainResult.reason },
          'Unexpected error during chain transaction sending.',
        );
      }
    });

    // 6. Build results from confirmed receipts
    for (const { transaction, receipt } of successfulSends) {
      const result = this.buildResult(transaction, receipt);
      results.push(result);
      this.metrics?.recordActionAttempt(result.route, result.success);
    }

    return results;
  }

  private filterTransactions(
    transactions: PreparedTransaction[],
  ): PreparedTransaction[] {
    const filteredTransactions: PreparedTransaction[] = [];
    for (const transaction of transactions) {
      const { origin, destination, amount } = transaction.route;
      const originToken = this.tokensByChainName[origin];
      const decimalFormattedAmount =
        transaction.originTokenAmount.getDecimalFormattedAmount();

      // minimum amount check
      const { bridgeMinAcceptedAmount } = getBridgeConfig(
        this.bridges,
        origin,
        destination,
        this.logger,
      );
      const minAccepted = BigInt(
        toWei(bridgeMinAcceptedAmount, originToken.decimals),
      );
      if (minAccepted > amount) {
        this.logger.info(
          {
            origin,
            destination,
            amount: decimalFormattedAmount,
            tokenName: originToken.name,
          },
          'Route skipped due to minimum threshold amount not met.',
        );
        continue;
      }
      filteredTransactions.push(transaction);
    }
    return filteredTransactions;
  }

  // === Parallel Transaction Sending Methods ===

  /**
   * Send all transactions for a single origin chain sequentially.
   * Sequential sending is required to avoid nonce contention when using the same signing key.
   */
  private async sendTransactionsForChain(
    origin: ChainName,
    transactions: PreparedTransaction[],
  ): Promise<
    Array<
      | {
          transaction: PreparedTransaction;
          receipt: providers.TransactionReceipt;
        }
      | { transaction: PreparedTransaction; error: string }
    >
  > {
    const results: Array<
      | {
          transaction: PreparedTransaction;
          receipt: providers.TransactionReceipt;
        }
      | { transaction: PreparedTransaction; error: string }
    > = [];

    // Send sequentially to avoid nonce contention
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

  /**
   * Build the execution result from a confirmed transaction receipt.
   * Receipt is already confirmed at reorgPeriod depth from sendTransaction.
   */
  private buildResult(
    transaction: PreparedTransaction,
    receipt: providers.TransactionReceipt,
  ): RebalanceExecutionResult {
    const { origin, destination } = transaction.route;

    let messageId: string | undefined;
    try {
      const dispatchedMessages = HyperlaneCore.getDispatchedMessages(receipt);
      messageId = dispatchedMessages[0]?.id;
    } catch {
      this.logger.debug(
        { origin, destination },
        'No dispatched message found in rebalance receipt.',
      );
    }

    return {
      route: transaction.route,
      success: true,
      messageId,
      txHash: receipt.transactionHash,
    };
  }

  private getReorgPeriod(chainName: string): number | string {
    const metadata = this.multiProvider.getChainMetadata(chainName);
    return metadata.blocks?.reorgPeriod ?? 32;
  }
}

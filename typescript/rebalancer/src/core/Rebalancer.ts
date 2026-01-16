import { type PopulatedTransaction } from 'ethers';
import { type Logger } from 'pino';

import {
  type ChainMap,
  type ChainMetadata,
  type ChainName,
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
  sleep,
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

    if (successfulSends.length === 0) {
      this.logger.info('No successful transactions to wait for confirmations.');
      return results;
    }

    // 6. Wait for all confirmations in parallel
    this.logger.info(
      { numTransactions: successfulSends.length },
      'Waiting for confirmations in parallel.',
    );

    const confirmResults = await Promise.allSettled(
      successfulSends.map(({ transaction, receipt }) =>
        this.waitAndBuildResult(transaction, receipt),
      ),
    );

    // 7. Collect confirmation results
    confirmResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        this.metrics?.recordActionAttempt(result.value.route, true);
      } else {
        results.push({
          route: successfulSends[i].transaction.route,
          success: false,
          error: `Confirmation failed: ${String(result.reason)}`,
        });
        this.metrics?.recordActionAttempt(
          successfulSends[i].transaction.route,
          false,
        );
      }
    });

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

        this.logger.info(
          {
            origin,
            destination: transaction.route.destination,
            amount: decimalFormattedAmount,
            tokenName,
          },
          'Sending rebalance transaction for route.',
        );

        const receipt = await this.multiProvider.sendTransaction(
          origin,
          transaction.populatedTx,
        );

        this.logger.info(
          {
            origin,
            destination: transaction.route.destination,
            amount: decimalFormattedAmount,
            tokenName,
            txHash: receipt.transactionHash,
          },
          'Rebalance transaction sent, will wait for confirmations.',
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
   * Wait for confirmations and build the execution result for a single transaction.
   */
  private async waitAndBuildResult(
    transaction: PreparedTransaction,
    receipt: providers.TransactionReceipt,
  ): Promise<RebalanceExecutionResult> {
    const { origin, destination } = transaction.route;
    const decimalFormattedAmount =
      transaction.originTokenAmount.getDecimalFormattedAmount();
    const tokenName = transaction.originTokenAmount.token.name;

    // Wait for confirmations
    await this.waitForConfirmations(origin, receipt.transactionHash);

    this.logger.info(
      {
        origin,
        destination,
        amount: decimalFormattedAmount,
        tokenName,
        txHash: receipt.transactionHash,
        txType: 'rebalance',
      },
      'Rebalance transaction confirmed at reorgPeriod depth.',
    );

    // Extract messageId from the rebalance transaction receipt
    let messageId: string | undefined;
    try {
      const dispatchedMessages = HyperlaneCore.getDispatchedMessages(receipt);
      messageId = dispatchedMessages[0]?.id;
    } catch {
      // Not all rebalance transactions dispatch messages (e.g., CCTP)
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

  // === Confirmation Waiting Methods ===

  /**
   * Get the reorgPeriod for a chain from its metadata.
   * Returns a number (block count) or string (e.g., "finalized" for Polygon).
   */
  private getReorgPeriod(chainName: string): number | string {
    const metadata = this.multiProvider.getChainMetadata(chainName);
    return metadata.blocks?.reorgPeriod ?? 32;
  }

  /**
   * Wait for a transaction to reach reorgPeriod confirmations.
   * This ensures the transaction is in the "confirmed block" range that Monitor uses.
   */
  private async waitForConfirmations(
    chainName: string,
    txHash: string,
  ): Promise<void> {
    const reorgPeriod = this.getReorgPeriod(chainName);
    const provider = this.multiProvider.getProvider(chainName);

    // Handle string block tags (e.g., "finalized" for Polygon)
    if (typeof reorgPeriod === 'string') {
      await this.waitForFinalizedBlock(chainName, txHash, reorgPeriod);
      return;
    }

    // Handle numeric reorgPeriod
    this.logger.info(
      { chain: chainName, txHash, confirmations: reorgPeriod },
      'Waiting for reorgPeriod confirmations',
    );

    await provider.waitForTransaction(txHash, reorgPeriod);

    this.logger.info(
      { chain: chainName, txHash },
      'Transaction confirmed at reorgPeriod depth',
    );
  }

  /**
   * Wait for a transaction to be included in a finalized/safe block.
   * Used for chains like Polygon that use string block tags instead of numeric reorgPeriod.
   */
  private async waitForFinalizedBlock(
    chainName: string,
    txHash: string,
    blockTag: string,
  ): Promise<void> {
    const provider = this.multiProvider.getProvider(chainName);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`Transaction receipt not found: ${txHash}`);
    }
    const txBlock = receipt.blockNumber;

    this.logger.info(
      { chain: chainName, txHash, txBlock, blockTag },
      'Waiting for transaction to be in finalized block',
    );

    const POLL_INTERVAL_MS = 2000;
    const MAX_WAIT_MS = 60000; // 1 minute timeout
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT_MS) {
      const taggedBlock = await provider.getBlock(blockTag);
      if (taggedBlock && taggedBlock.number >= txBlock) {
        this.logger.info(
          { chain: chainName, txHash, finalizedBlock: taggedBlock.number },
          'Transaction is in finalized block range',
        );
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    this.logger.warn(
      { chain: chainName, txHash, blockTag },
      'Timeout waiting for finalized block, proceeding anyway',
    );
  }
}

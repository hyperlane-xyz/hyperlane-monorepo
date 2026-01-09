import { BigNumber, type PopulatedTransaction, type providers } from 'ethers';
import { type Logger } from 'pino';

import {
  type ChainMap,
  type ChainMetadata,
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

    // 3. Get sender address for approval check
    const signer = this.multiProvider.getSigner(origin);
    const signerAddress = await signer.getAddress();

    // 4. Populate transaction(s) - may include approval tx if needed
    let populatedTxs: PopulatedTransaction[];
    try {
      populatedTxs = await originHypAdapter.populateRebalanceTx(
        destinationChainMeta.domainId,
        amount,
        bridge,
        quotes,
        signerAddress,
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

    return { populatedTxs, route, originTokenAmount };
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

    // 1. Estimate gas for all transactions in each PreparedTransaction
    const gasEstimateResults = await Promise.allSettled(
      transactions.map(async (transaction) => {
        // Estimate gas for each tx in the array (approval + rebalance)
        // Skip gas estimation for approval txs (they're simple and predictable)
        // This avoids issues with USDC-style tokens where gas estimation of
        // the approve tx fails because the revoke tx hasn't been executed yet
        for (let i = 0; i < transaction.populatedTxs.length; i++) {
          const tx = transaction.populatedTxs[i];
          const isApprovalTx = i < transaction.populatedTxs.length - 1;

          if (isApprovalTx) {
            // Set a fixed gas limit for approval txs (50k is plenty)
            tx.gasLimit = BigNumber.from(50000);
          } else {
            await this.multiProvider.estimateGas(transaction.route.origin, tx);
          }
        }
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

    // 3. Send transactions
    this.logger.info(
      { numTransactions: validTransactions.length },
      'Sending valid transactions.',
    );

    for (const transaction of validTransactions) {
      try {
        const { origin, destination } = transaction.route;
        const decimalFormattedAmount =
          transaction.originTokenAmount.getDecimalFormattedAmount();
        const tokenName = transaction.originTokenAmount.token.name;

        let rebalanceReceipt: providers.TransactionReceipt | undefined;

        // Execute all transactions sequentially (approval first, then rebalance)
        for (let i = 0; i < transaction.populatedTxs.length; i++) {
          const tx = transaction.populatedTxs[i];
          const isApprovalTx = i < transaction.populatedTxs.length - 1;

          this.logger.info(
            {
              origin,
              destination,
              amount: decimalFormattedAmount,
              tokenName,
              txType: isApprovalTx ? 'approval' : 'rebalance',
              txIndex: i + 1,
              totalTxs: transaction.populatedTxs.length,
            },
            `Sending ${isApprovalTx ? 'approval' : 'rebalance'} transaction for route.`,
          );

          const receipt = await this.multiProvider.sendTransaction(origin, tx);

          this.logger.info(
            {
              origin,
              destination,
              amount: decimalFormattedAmount,
              tokenName,
              txHash: receipt.transactionHash,
              txType: isApprovalTx ? 'approval' : 'rebalance',
            },
            `${isApprovalTx ? 'Approval' : 'Rebalance'} transaction confirmed for route.`,
          );

          // Keep track of the rebalance (last) transaction receipt
          if (!isApprovalTx) {
            rebalanceReceipt = receipt;
          }
        }

        // Extract messageId from the rebalance transaction receipt
        let messageId: string | undefined;
        if (rebalanceReceipt) {
          try {
            const dispatchedMessages =
              HyperlaneCore.getDispatchedMessages(rebalanceReceipt);
            messageId = dispatchedMessages[0]?.id;
          } catch {
            // Not all rebalance transactions dispatch messages (e.g., CCTP)
            this.logger.debug(
              { origin, destination },
              'No dispatched message found in rebalance receipt.',
            );
          }
        }

        results.push({
          route: transaction.route,
          success: true,
          messageId,
          txHash: rebalanceReceipt?.transactionHash,
        });
        this.metrics?.recordActionAttempt(transaction.route, true);
      } catch (error) {
        this.logger.error(
          {
            origin: transaction.route.origin,
            destination: transaction.route.destination,
            amount: transaction.originTokenAmount.getDecimalFormattedAmount(),
            tokenName: transaction.originTokenAmount.token.name,
            error,
          },
          'Transaction failed for route.',
        );
        results.push({
          route: transaction.route,
          success: false,
          error: String(error),
        });
        this.metrics?.recordActionAttempt(transaction.route, false);
      }
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
}

import { PopulatedTransaction } from 'ethers';

import {
  type ChainMap,
  type ChainMetadata,
  EvmHypCollateralAdapter,
  InterchainGasQuote,
  type MultiProvider,
  type Token,
  TokenAmount,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';

import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';
import { type BridgeConfig, getBridgeConfig } from '../utils/bridgeConfig.js';
import { rebalancerLogger } from '../utils/logger.js';

type PreparedTransaction = {
  populatedTx: Awaited<
    ReturnType<EvmHypCollateralAdapter['populateRebalanceTx']>
  >;
  route: RebalancingRoute;
  originTokenAmount: TokenAmount;
};

export class Rebalancer implements IRebalancer {
  constructor(
    private readonly bridges: ChainMap<BridgeConfig>,
    private readonly warpCore: WarpCore,
    private readonly chainMetadata: ChainMap<ChainMetadata>,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
  ) {}

  async rebalance(routes: RebalancingRoute[]) {
    if (routes.length === 0) {
      rebalancerLogger.info('No routes to execute, exiting');
      return;
    }

    rebalancerLogger.info(
      { numberOfRoutes: routes.length },
      'Rebalance initiated',
    );

    const { preparedTransactions, preparationFailures } =
      await this.prepareTransactions(routes);

    let gasEstimationFailures = 0;
    let transactionFailures = 0;

    if (preparedTransactions.length > 0) {
      const filteredTransactions =
        this.filterTransactions(preparedTransactions);

      if (filteredTransactions.length > 0) {
        ({ gasEstimationFailures, transactionFailures } =
          await this.executeTransactions(filteredTransactions));
      }
    }

    if (
      preparationFailures > 0 ||
      gasEstimationFailures > 0 ||
      transactionFailures > 0
    ) {
      rebalancerLogger.error(
        {
          preparationFailures,
          gasEstimationFailures,
          transactionFailures,
        },
        'A rebalance stage failed.',
      );
      throw new Error('❌ Some rebalance transaction failed');
    }

    rebalancerLogger.info('✅ Rebalance successful');
  }

  private async prepareTransactions(routes: RebalancingRoute[]): Promise<{
    preparedTransactions: PreparedTransaction[];
    preparationFailures: number;
  }> {
    rebalancerLogger.info(
      { numRoutes: routes.length },
      'Preparing all rebalance transactions.',
    );
    const settledResults = await Promise.allSettled(
      routes.map((route) => this.prepareTransaction(route)),
    );

    const preparedTransactions: PreparedTransaction[] = [];
    for (const result of settledResults) {
      if (result.status === 'fulfilled' && result.value) {
        preparedTransactions.push(result.value);
      }
    }
    const preparationFailures = routes.length - preparedTransactions.length;

    return { preparedTransactions, preparationFailures };
  }

  private async prepareTransaction(
    route: RebalancingRoute,
  ): Promise<PreparedTransaction | null> {
    const { origin, destination, amount } = route;

    rebalancerLogger.info(
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
    ) as EvmHypCollateralAdapter;
    const { bridge, bridgeIsWarp } = getBridgeConfig(
      this.bridges,
      origin,
      destination,
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
      rebalancerLogger.error(
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
      rebalancerLogger.error(
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
      rebalancerLogger.error(
        { origin, destination, amount },
        'Route validation failed: origin token not found.',
      );
      return false;
    }

    const originTokenAmount = originToken.amount(amount);
    const decimalFormattedAmount =
      originTokenAmount.getDecimalFormattedAmount();

    if (!destinationToken) {
      rebalancerLogger.error(
        { origin, destination, amount: decimalFormattedAmount },
        'Route validation failed: destination token not found.',
      );
      return false;
    }

    if (!destinationDomain) {
      rebalancerLogger.error(
        { origin, destination, amount: decimalFormattedAmount },
        'Route validation failed: destination domain metadata not found.',
      );
      return false;
    }

    const originHypAdapter = originToken.getHypAdapter(
      this.warpCore.multiProvider,
    );
    if (!(originHypAdapter instanceof EvmHypCollateralAdapter)) {
      rebalancerLogger.error(
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
      rebalancerLogger.error(
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
    if (allowedDestination !== destinationToken.addressOrDenom) {
      rebalancerLogger.error(
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

    const { bridge } = getBridgeConfig(this.bridges, origin, destination);
    if (
      !(await originHypAdapter.isBridgeAllowed(
        destinationDomain.domainId,
        bridge,
      ))
    ) {
      rebalancerLogger.error(
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
  ): Promise<{
    gasEstimationFailures: number;
    transactionFailures: number;
  }> {
    rebalancerLogger.info(
      { numTransactions: transactions.length },
      'Estimating gas for all prepared transactions.',
    );

    // 1. Estimate gas
    const gasEstimateResults = await Promise.allSettled(
      transactions.map(async (transaction) => {
        await this.multiProvider.estimateGas(
          transaction.route.origin,
          transaction.populatedTx,
        );
        return transaction;
      }),
    );

    // 2. Filter out failed transactions and log errors
    const validTransactions: PreparedTransaction[] = [];
    let gasEstimationFailures = 0;
    gasEstimateResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        validTransactions.push(result.value);
      } else {
        gasEstimationFailures++;
        const failedTransaction = transactions[i];
        rebalancerLogger.error(
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
      }
    });

    if (validTransactions.length === 0) {
      rebalancerLogger.info('No transactions to execute after gas estimation.');
      return {
        gasEstimationFailures,
        transactionFailures: 0,
      };
    }

    // 2. Send transactions
    rebalancerLogger.info(
      { numTransactions: validTransactions.length },
      'Sending valid transactions.',
    );
    const transactionResults = await Promise.allSettled(
      validTransactions.map(async (transaction) => {
        const { origin, destination } = transaction.route;
        const decimalFormattedAmount =
          transaction.originTokenAmount.getDecimalFormattedAmount();
        const tokenName = transaction.originTokenAmount.token.name;
        rebalancerLogger.info(
          {
            origin,
            destination,
            amount: decimalFormattedAmount,
            tokenName,
          },
          'Sending transaction for route.',
        );
        const receipt = await this.multiProvider.sendTransaction(
          origin,
          transaction.populatedTx,
        );
        rebalancerLogger.info(
          {
            origin,
            destination,
            amount: decimalFormattedAmount,
            tokenName,
            txHash: receipt.transactionHash,
          },
          'Transaction confirmed for route.',
        );
        return { transaction, receipt };
      }),
    );

    // 3. Process results and log errors
    let transactionFailures = 0;
    transactionResults.forEach((result, i) => {
      if (result.status === 'rejected') {
        transactionFailures++;
        const failedTransaction = validTransactions[i];
        rebalancerLogger.error(
          {
            origin: failedTransaction.route.origin,
            destination: failedTransaction.route.destination,
            amount:
              failedTransaction.originTokenAmount.getDecimalFormattedAmount(),
            tokenName: failedTransaction.originTokenAmount.token.name,
            error: result.reason,
          },
          'Transaction failed for route.',
        );
      }
    });

    return {
      gasEstimationFailures,
      transactionFailures,
    };
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
      );
      const minAccepted = BigInt(
        toWei(bridgeMinAcceptedAmount, originToken.decimals),
      );
      if (minAccepted > amount) {
        rebalancerLogger.info(
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

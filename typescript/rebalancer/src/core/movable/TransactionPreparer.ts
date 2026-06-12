import { type PopulatedTransaction } from 'ethers';
import { type Logger } from 'pino';

import {
  type ChainMap,
  type ChainMetadata,
  EvmMovableCollateralAdapter,
  type InterchainGasQuote,
  type Token,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { mapAllSettled } from '@hyperlane-xyz/utils';

import type { PreparedTransaction } from '../../interfaces/IRebalancer.js';
import { denormalizeToLocal } from '../../utils/balanceUtils.js';
import { MovableRouteValidator } from './RouteValidator.js';
import type {
  MovableInternalExecutionResult,
  MovableInternalRoute,
} from './types.js';

export class MovableTransactionPreparer {
  constructor(
    private readonly warpCore: WarpCore,
    private readonly chainMetadata: ChainMap<ChainMetadata>,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly routeValidator: MovableRouteValidator,
    private readonly logger: Logger,
  ) {}

  async prepareTransactions(routes: MovableInternalRoute[]): Promise<{
    preparedTransactions: PreparedTransaction[];
    preparationFailureResults: MovableInternalExecutionResult[];
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

    const preparedTransactions: PreparedTransaction[] = [];
    const preparationFailureResults: MovableInternalExecutionResult[] = [];

    for (const [i, tx] of fulfilled) {
      const route = routes[i];
      if (tx) {
        preparedTransactions.push(tx);
      } else {
        preparationFailureResults.push({
          route,
          intentId: route.intentId,
          success: false,
          error: 'Preparation returned null',
          messageId: '',
        });
      }
    }

    for (const [i, error] of rejected) {
      const route = routes[i];
      preparationFailureResults.push({
        route,
        intentId: route.intentId,
        success: false,
        error: String(error),
        messageId: '',
      });
    }

    return { preparedTransactions, preparationFailureResults };
  }

  async prepareTransaction(
    route: MovableInternalRoute,
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

    if (!(await this.routeValidator.validate(route))) {
      return null;
    }

    const originToken = this.tokensByChainName[origin];
    const destinationToken = this.tokensByChainName[destination];
    const destinationChainMeta = this.chainMetadata[destination];
    const localAmount = denormalizeToLocal(amount, originToken);

    const originTokenAmount = originToken.amount(localAmount);
    const decimalFormattedAmount =
      originTokenAmount.getDecimalFormattedAmount();
    const originHypAdapter = originToken.getHypAdapter(
      this.warpCore.multiProvider,
    ) as EvmMovableCollateralAdapter;

    let quotes: InterchainGasQuote[];
    try {
      quotes = await originHypAdapter.getRebalanceQuotes(
        route.bridge,
        destinationChainMeta.domainId,
        destinationToken.addressOrDenom,
        localAmount,
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

    let populatedTx: PopulatedTransaction;
    try {
      populatedTx = await originHypAdapter.populateRebalanceTx(
        destinationChainMeta.domainId,
        localAmount,
        route.bridge,
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
}

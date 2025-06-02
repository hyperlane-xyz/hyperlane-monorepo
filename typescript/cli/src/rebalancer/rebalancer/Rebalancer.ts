import {
  type ChainMap,
  type ChainMetadata,
  EvmHypCollateralAdapter,
  type InterchainGasQuote,
  type MultiProvider,
  type Token,
  type TokenAmount,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';

import { errorRed, log } from '../../logger.js';
import { WrappedError } from '../../utils/errors.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';
import { type BridgeConfig, getBridgeConfig } from '../utils/bridgeConfig.js';

export class Rebalancer implements IRebalancer {
  constructor(
    private readonly bridges: ChainMap<BridgeConfig>,
    private readonly warpCore: WarpCore,
    private readonly chainMetadata: ChainMap<ChainMetadata>,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
  ) {}

  async rebalance(routes: RebalancingRoute[]) {
    log('Rebalance initiated', { numberOfRoutes: routes.length });

    if (routes.length === 0) {
      log('No routes to execute');
      return;
    }

    const { warpCore, chainMetadata, tokensByChainName } = this;

    const transactions: {
      populatedTx: Awaited<
        ReturnType<EvmHypCollateralAdapter['populateRebalanceTx']>
      >;
      route: RebalancingRoute;
      originTokenAmount: TokenAmount;
    }[] = [];

    for (const route of routes) {
      const { origin, destination, amount } = route;

      const originToken = tokensByChainName[origin];
      const destinationToken = tokensByChainName[destination];

      if (originToken === undefined) {
        throw new Error(
          `Token not found for chain ${origin}, for route from ${route.origin} to ${route.destination} for ${route.amount}`,
        );
      }

      if (destinationToken === undefined) {
        throw new Error(
          `Token not found for chain ${destination}, for route from ${route.origin} to ${route.destination} for ${route.amount}`,
        );
      }

      const originTokenAmount = originToken.amount(amount);
      const decimalFormatAmount = originTokenAmount.getDecimalFormattedAmount();

      log('Preparing transaction', {
        origin,
        destination,
        amount: decimalFormatAmount,
        tokenName: originToken.name,
      });

      const originHypAdapter = originToken.getHypAdapter(
        warpCore.multiProvider,
      );

      if (!(originHypAdapter instanceof EvmHypCollateralAdapter)) {
        throw new Error(
          `Adapter is not an EvmHypCollateralAdapter. Chain: ${origin}.`,
        );
      }

      const signer = this.multiProvider.getSigner(origin);
      const signerAddress = await signer.getAddress();
      const domain = chainMetadata[destination].domainId;
      const recipient = destinationToken.addressOrDenom;
      const { bridge, bridgeMinAcceptedAmount, bridgeIsWarp } = getBridgeConfig(
        this.bridges,
        origin,
        destination,
      );

      if (!(await originHypAdapter.isRebalancer(signerAddress))) {
        throw new Error(
          `Signer ${signerAddress} is not a rebalancer. Token: ${originToken.addressOrDenom}. Chain: ${origin}.`,
        );
      }

      if (
        (await originHypAdapter.getAllowedDestination(domain)) !== recipient
      ) {
        throw new Error(
          `Destination ${recipient} for domain ${domain} (${destination}) is not allowed. From ${originToken.addressOrDenom} at ${origin}.`,
        );
      }

      if (!(await originHypAdapter.isBridgeAllowed(domain, bridge))) {
        throw new Error(
          `Bridge ${bridge} for domain ${domain} (${destination}) is not allowed. From ${originToken.addressOrDenom} at ${origin}. To ${recipient} at ${destination}.`,
        );
      }

      // Skip this rebalance route if the amount is below the configured minimum threshold.
      // This prevents dust amounts or economically unviable transfers
      const minAccepted = BigInt(
        toWei(bridgeMinAcceptedAmount, originTokenAmount.token.decimals),
      );
      if (minAccepted > amount) {
        log('Route skipped due to minimum threshold', {
          origin,
          destination,
          amount: amount.toString(),
          tokenName: originToken.name,
          configuredMinAcceptedAmount: bridgeMinAcceptedAmount.toString(),
          effectiveMinAcceptedWei: minAccepted.toString(),
        });

        continue;
      }

      log('Getting rebalance quotes', {
        domain,
        amount: decimalFormatAmount,
        tokenName: originToken.name,
        bridge,
      });

      let quotes: InterchainGasQuote[];

      try {
        quotes = await originHypAdapter.getRebalanceQuotes(
          bridge,
          domain,
          recipient,
          amount,
          bridgeIsWarp,
        );
      } catch (error) {
        throw new WrappedError(
          `Could not get rebalance quotes from ${origin} to ${destination}, for ${decimalFormatAmount} ${originToken.name}`,
          error as Error,
        );
      }

      log('Populating rebalance transaction', {
        domain,
        amount: decimalFormatAmount,
        tokenName: originToken.name,
        bridge,
      });

      const populatedTx = await originHypAdapter.populateRebalanceTx(
        domain,
        amount,
        bridge,
        quotes,
      );

      transactions.push({
        populatedTx,
        route,
        originTokenAmount: originToken.amount(amount),
      });
    }

    // Early return if no valid routes were found to rebalance.
    // This happens when all potential routes were skipped (e.g., due to minimum amounts)
    if (transactions.length === 0) {
      log('Rebalance skipped: No routes to execute after filtering');

      return;
    }

    log('Estimating gas for all transactions', {
      numTransactions: transactions.length,
    });

    // Estimate gas before sending transactions.
    // This is mainly to check that the transaction will not fail before sending them.
    const estimateGasResults = await Promise.allSettled(
      transactions.map(async ({ populatedTx, route, originTokenAmount }) => {
        try {
          await this.multiProvider.estimateGas(route.origin, populatedTx);
          log('Gas estimation succeeded for route', {
            origin: route.origin,
            destination: route.destination,
            amount: originTokenAmount.getDecimalFormattedAmount(),
            tokenName: originTokenAmount.token.name,
          });
        } catch (error) {
          log('Gas estimation failed for route (attempt details)', {
            origin: route.origin,
            destination: route.destination,
            amount: originTokenAmount.getDecimalFormattedAmount(),
            tokenName: originTokenAmount.token.name,
            err: error,
          });
          throw error;
        }
      }),
    );

    if (estimateGasResults.some((result) => result.status === 'rejected')) {
      estimateGasResults.forEach((tx, index) => {
        if (tx.status === 'rejected') {
          const { route, originTokenAmount } = transactions[index];
          errorRed('Could not estimate gas for route', {
            origin: route.origin,
            destination: route.destination,
            amount: originTokenAmount.getDecimalFormattedAmount(),
            tokenName: originTokenAmount.token.name,
            reason: tx.reason,
          });
        }
      });

      throw new Error('❌ Could not estimate gas for some routes');
    }

    log('Sending transactions', { numTransactions: transactions.length });
    const results = await Promise.allSettled(
      transactions.map(async ({ populatedTx, route, originTokenAmount }) => {
        log('Sending transaction for route', {
          origin: route.origin,
          destination: route.destination,
          amount: originTokenAmount.getDecimalFormattedAmount(),
          tokenName: originTokenAmount.token.name,
        });
        try {
          const receipt = await this.multiProvider.sendTransaction(
            route.origin,
            populatedTx,
          );
          log('Transaction confirmed for route', {
            origin: route.origin,
            destination: route.destination,
            amount: originTokenAmount.getDecimalFormattedAmount(),
            tokenName: originTokenAmount.token.name,
            txHash: receipt.transactionHash,
          });
          return receipt;
        } catch (error) {
          errorRed('Transaction failed for route', {
            origin: route.origin,
            destination: route.destination,
            amount: originTokenAmount.getDecimalFormattedAmount(),
            tokenName: originTokenAmount.token.name,
            err: error,
          });
          throw error;
        }
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const { route, originTokenAmount } = transactions[i];

      log('Route result summary', {
        origin: route.origin,
        destination: route.destination,
        amount: originTokenAmount.getDecimalFormattedAmount(),
        tokenName: originTokenAmount.token.name,
        status: result.status,
      });

      if (result.status === 'fulfilled') {
        log('Transaction receipt details', {
          origin: route.origin,
          destination: route.destination,
          receipt: result.value,
        });
      } else {
        errorRed('Route processing failed', {
          origin: route.origin,
          destination: route.destination,
          err: result.reason,
        });
      }
    }

    if (results.every((result) => result.status === 'fulfilled')) {
      log('✅ Rebalance successful');
    } else {
      log('❌ Some rebalance transaction failed');
    }
  }
}

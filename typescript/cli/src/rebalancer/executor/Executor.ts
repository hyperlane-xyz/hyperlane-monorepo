import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  EvmHypCollateralAdapter,
  InterchainGasQuote,
  Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { stringifyObject } from '@hyperlane-xyz/utils';

import { errorRed, log } from '../../logger.js';
import type { IExecutor } from '../interfaces/IExecutor.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';
import { type BridgeConfig, getBridgeConfig } from '../utils/bridgeConfig.js';

export class Executor implements IExecutor {
  private readonly tokensByChainName: Map<ChainName, Token>;

  constructor(
    private readonly bridges: ChainMap<BridgeConfig>,
    private readonly rebalancerKey: string,
    private readonly warpCore: WarpCore,
    private readonly chainMetadata: ChainMap<ChainMetadata>,
  ) {
    this.tokensByChainName = new Map(
      warpCore.tokens.map((t) => [t.chainName, t]),
    );
  }

  async rebalance(routes: RebalancingRoute[]) {
    log(`Rebalance initiated with ${routes.length} route(s)`);

    if (routes.length === 0) {
      log('No routes to execute');
      return;
    }

    const { warpCore, chainMetadata, tokensByChainName } = this;

    const transactions: {
      signer: ethers.Signer;
      populatedTx: ethers.PopulatedTransaction;
    }[] = [];

    for (const { origin, destination, amount } of routes) {
      log(
        `Preparing transaction: from ${origin} to ${destination}, amount: ${amount}`,
      );
      const originToken = tokensByChainName.get(origin);
      const destinationToken = tokensByChainName.get(destination);

      if (!originToken) {
        throw new Error(`Token not found for chain ${origin}`);
      }

      if (!destinationToken) {
        throw new Error(`Token not found for chain ${destination}`);
      }

      const originHypAdapter = originToken.getHypAdapter(
        warpCore.multiProvider,
      );

      if (!(originHypAdapter instanceof EvmHypCollateralAdapter)) {
        throw new Error(
          `Adapter is not an EvmHypCollateralAdapter. Chain: ${origin}.`,
        );
      }

      const provider = warpCore.multiProvider.getEthersV5Provider(origin);
      const signer = new ethers.Wallet(this.rebalancerKey, provider);
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
      if (bridgeMinAcceptedAmount > amount) {
        log(
          `Route ${origin} → ${destination} skipped: amount ${amount} below minimum threshold ${bridgeMinAcceptedAmount}`,
        );

        continue;
      }

      log(
        `Getting rebalance quotes: domain=${domain}, amount=${amount}, bridge=${bridge}`,
      );

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
        throw new Error(
          `Could not get rebalance quotes from ${origin} to ${destination}: ${(error as Error).message}`,
        );
      }

      log(
        `Populating rebalance transaction: domain=${domain}, amount=${amount}, bridge=${bridge}`,
      );

      const populatedTx = await originHypAdapter.populateRebalanceTx(
        domain,
        amount,
        bridge,
        quotes,
      );

      transactions.push({ signer, populatedTx });
    }

    // Early return if no valid routes were found to rebalance.
    // This happens when all potential routes were skipped (e.g., due to minimum amounts)
    if (transactions.length === 0) {
      log('Rebalance skipped: No routes to execute');

      return;
    }

    log('Estimating gas for all transactions');

    // Estimate gas before sending transactions.
    // This is mainly to check that the transaction will not fail before sending them.
    const estimateGasResults = await Promise.allSettled(
      transactions.map(async ({ signer, populatedTx }, i) => {
        try {
          await signer.estimateGas(populatedTx);
          log(`Gas estimation succeeded for route ${i}`);
        } catch (error) {
          log(`❌ Could not estimate gas for route`, routes[i]);
          throw error;
        }
      }),
    );

    if (estimateGasResults.some((result) => result.status === 'rejected')) {
      throw new Error('❌ Could not estimate gas for some routes');
    }

    log('Sending transactions');
    const results = await Promise.allSettled(
      transactions.map(async ({ signer, populatedTx }, i) => {
        log(`Sending transaction for route ${i}`);
        try {
          const tx = await signer.sendTransaction(populatedTx);
          log(`Transaction sent: ${tx.hash}`);
          const receipt = await tx.wait();
          log(`Transaction confirmed: ${tx.hash}`);
          return receipt;
        } catch (error) {
          errorRed(`Transaction failed for route ${i}: ${error}`);
          throw error;
        }
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const route = routes[i];

      log(
        `Route result - Origin: ${route.origin}, Destination: ${route.destination}, Amount: ${route.amount}`,
      );

      if (result.status === 'fulfilled') {
        log(`Transaction receipt: ${stringifyObject(result.value)}`);
      } else {
        errorRed(
          result.reason instanceof Error
            ? result.reason.message
            : result.reason,
        );
      }
    }

    if (results.every((result) => result.status === 'fulfilled')) {
      log('✅ Rebalance successful');
    } else {
      log('❌ Some rebalance transaction failed');
    }
  }
}

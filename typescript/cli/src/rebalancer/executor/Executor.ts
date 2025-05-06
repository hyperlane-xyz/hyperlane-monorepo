import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  EvmHypCollateralAdapter,
  Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { log } from '../../logger.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

export class Executor implements IExecutor {
  private readonly tokensByChainName: Map<ChainName, Token>;

  constructor(
    private readonly bridges: ChainMap<Address>,
    private readonly rebalancerKey: string,
    private readonly warpCore: WarpCore,
    private readonly chainMetadata: ChainMap<ChainMetadata>,
  ) {
    this.tokensByChainName = new Map(
      warpCore.tokens.map((t) => [t.chainName, t]),
    );
  }

  async rebalance(routes: RebalancingRoute[]) {
    if (routes.length === 0) {
      log('No routes to execute');

      return;
    }

    const { warpCore, chainMetadata, tokensByChainName } = this;

    const transactions: {
      signer: ethers.Signer;
      populatedTx: ethers.PopulatedTransaction;
    }[] = [];

    for (const { fromChain, toChain, amount } of routes) {
      const originToken = tokensByChainName.get(fromChain);
      const destinationToken = tokensByChainName.get(toChain);

      if (!originToken) {
        throw new Error(`Token not found for chain ${fromChain}`);
      }

      if (!destinationToken) {
        throw new Error(`Token not found for chain ${toChain}`);
      }

      const originHypAdapter = originToken.getHypAdapter(
        warpCore.multiProvider,
      );

      if (!(originHypAdapter instanceof EvmHypCollateralAdapter)) {
        throw new Error('Adapter is not an EvmHypCollateralAdapter');
      }

      const provider = warpCore.multiProvider.getEthersV5Provider(fromChain);
      const signer = new ethers.Wallet(this.rebalancerKey, provider);
      const signerAddress = await signer.getAddress();
      const domain = chainMetadata[toChain].domainId;
      const bridge = this.bridges[fromChain];

      if (!(await originHypAdapter.isRebalancer(signerAddress))) {
        throw new Error(`Signer ${signerAddress} is not a rebalancer`);
      }

      if (
        (await originHypAdapter.getAllowedDestination(domain)) !==
        destinationToken.addressOrDenom
      ) {
        throw new Error(
          `Destination ${destinationToken.addressOrDenom} for domain ${domain} is not allowed`,
        );
      }

      if (!(await originHypAdapter.isBridgeAllowed(domain, bridge))) {
        throw new Error(`Bridge ${bridge} for domain ${domain} is not allowed`);
      }

      const populatedTx = await originHypAdapter.populateRebalanceTx({
        domain,
        amount,
        bridge,
      });

      transactions.push({ signer, populatedTx });
    }

    const results = await Promise.allSettled(
      transactions.map(async ({ signer, populatedTx }) => {
        console.log('populatedTx', populatedTx);
        const tx = await signer.sendTransaction(populatedTx);
        const receipt = await tx.wait();

        return receipt;
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const route = routes[i];

      log(
        `Origin: ${route.fromChain}, Destination: ${route.toChain}, Amount: ${route.amount}`,
      );

      if (result.status === 'fulfilled') {
        log(JSON.stringify(result.value, null, 2));
      } else {
        log(
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

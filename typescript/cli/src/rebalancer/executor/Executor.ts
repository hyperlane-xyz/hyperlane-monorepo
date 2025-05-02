import { ethers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  EvmHypCollateralAdapter,
  MultiProtocolProvider,
  Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { Address, objMap, objMerge } from '@hyperlane-xyz/utils';

import { log, logDebug, logGreen, logRed } from '../../logger.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

export class Executor implements IExecutor {
  private initData?: {
    warpCore: WarpCore;
    chainMetadata: ChainMap<ChainMetadata>;
    tokensByChainName: Map<ChainName, Token>;
  };

  constructor(
    private readonly bridges: ChainMap<Address>,
    private readonly rebalancerKey: string,
  ) {}

  async init(registry: IRegistry, warpRouteId: string): Promise<Executor> {
    if (this.initData) {
      throw new Error('Executor already initialized');
    }

    const metadata = await registry.getMetadata();
    const addresses = await registry.getAddresses();
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));
    const provider = new MultiProtocolProvider(objMerge(metadata, mailboxes));
    const warpCoreConfig = await registry.getWarpRoute(warpRouteId);
    const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);

    this.initData = {
      warpCore,
      chainMetadata: metadata,
      tokensByChainName: new Map(warpCore.tokens.map((t) => [t.chainName, t])),
    };

    return this;
  }

  async rebalance(routes: RebalancingRoute[]) {
    if (!this.initData) {
      throw new Error('Executor not initialized');
    }

    if (routes.length === 0) {
      log('No routes to execute');

      return;
    }

    const { warpCore, chainMetadata, tokensByChainName } = this.initData;

    const transactions: {
      provider: ethers.providers.Provider;
      populatedTx: ethers.PopulatedTransaction;
    }[] = [];

    for (const { fromChain, toChain, amount } of routes) {
      const originToken = tokensByChainName.get(fromChain);

      if (!originToken) {
        throw new Error(`Token not found for chain ${fromChain}`);
      }

      const hypAdapter = originToken.getHypAdapter(warpCore.multiProvider);

      if (!(hypAdapter instanceof EvmHypCollateralAdapter)) {
        throw new Error('Adapter is not an EvmHypCollateralAdapter');
      }

      const hypCollateralAdapter = hypAdapter as EvmHypCollateralAdapter;

      const provider = warpCore.multiProvider.getEthersV5Provider(toChain);

      const populatedTx = await hypCollateralAdapter.populateRebalanceTx({
        domain: chainMetadata[toChain].domainId,
        amount,
        bridge: this.bridges[toChain],
      });

      transactions.push({ provider, populatedTx });
    }

    const results = await Promise.allSettled(
      transactions.map(async ({ provider, populatedTx }) => {
        const signer = new ethers.Wallet(this.rebalancerKey, provider);
        const tx = await signer.sendTransaction(populatedTx);
        const receipt = await tx.wait();

        return receipt;
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const route = routes[i];

      logDebug(
        `origin: ${route.fromChain}, destination: ${route.toChain}, amount: ${route.amount}`,
      );

      if (result.status === 'fulfilled') {
        logGreen(`✅ Rebalance successful`);
        log(JSON.stringify(result.value, null, 2));
      } else {
        logRed(`❌ Rebalance failed`);
        log(
          result.reason instanceof Error
            ? result.reason.message
            : result.reason,
        );
      }
    }
  }
}

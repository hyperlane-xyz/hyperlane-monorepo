import { ethers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  EvmHypCollateralAdapter,
  MultiProtocolProvider,
  Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { Address, objMap, objMerge } from '@hyperlane-xyz/utils';

export type RebalanceArgs = {
  origin: Token;
  destination: Token;
  amount: bigint;
}[];

export class Executor {
  private initData?: {
    warpCore: WarpCore;
    chainMetadata: ChainMap<ChainMetadata>;
  };

  constructor(
    private readonly bridges: ChainMap<Address>,
    private readonly rebalancerKey: string,
  ) {}

  async init(registry: IRegistry, warpRouteId: string) {
    if (this.initData) {
      throw new Error('Executor already initialized');
    }

    const metadata = await registry.getMetadata();
    const addresses = await registry.getAddresses();
    const mailboxes = objMap(addresses, (_, { mailbox }) => ({ mailbox }));
    const provider = new MultiProtocolProvider(objMerge(metadata, mailboxes));
    const warpCoreConfig = await registry.getWarpRoute(warpRouteId);
    const warpCore = WarpCore.FromConfig(provider, warpCoreConfig);

    this.initData = { warpCore, chainMetadata: metadata };
  }

  async rebalance(args: RebalanceArgs) {
    if (!this.initData) {
      throw new Error('Executor not initialized');
    }

    const { warpCore, chainMetadata } = this.initData;

    for (const { origin, destination, amount } of args) {
      const hypAdapter = origin.getHypAdapter(warpCore.multiProvider);

      if (!(hypAdapter instanceof EvmHypCollateralAdapter)) {
        throw new Error('Adapter is not an EvmHypCollateralAdapter');
      }

      const collateralAdapter = hypAdapter as EvmHypCollateralAdapter;

      const populatedTx = await collateralAdapter.populateRebalanceTx({
        domain: chainMetadata[destination.chainName].domainId,
        amount,
        bridge: this.bridges[destination.chainName],
      });

      const provider = warpCore.multiProvider.getEthersV5Provider(
        destination.chainName,
      );

      const signer = new ethers.Wallet(this.rebalancerKey, provider);

      const tx = await signer.sendTransaction(populatedTx);

      await tx.wait();
    }
  }
}

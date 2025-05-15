import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

export type RawBalances = ChainMap<bigint>;

export type RebalancingRoute = {
  fromChain: ChainName;
  toChain: ChainName;
  amount: bigint;
};

export interface IStrategy {
  getRebalancingRoutes(rawBalances: RawBalances): RebalancingRoute[];
}

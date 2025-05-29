import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

export enum StrategyOptions {
  Weighted = 'weighted',
  MinAmount = 'minAmount',
}

export type RawBalances = ChainMap<bigint>;

export type RebalancingRoute = {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
};

export interface IStrategy {
  getRebalancingRoutes(rawBalances: RawBalances): RebalancingRoute[];
}

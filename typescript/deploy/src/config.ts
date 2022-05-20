import { ChainMap, ChainName, IChainConnection } from '@abacus-network/sdk';

export interface CheckerViolation {
  chain: ChainName;
  type: string;
  expected: any;
  actual: any;
  data?: any;
}

export type EnvironmentConfig<Chain extends ChainName> = ChainMap<
  Chain,
  IChainConnection
>;

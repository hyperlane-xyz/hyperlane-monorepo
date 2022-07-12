import { Contract, ContractTransaction } from 'ethers';

import type { types } from '@abacus-network/utils';

import type { ChainMap, ChainName, IChainConnection } from '../types';

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

export interface Ownable extends Contract {
  owner(): Promise<types.Address>;
  transferOwnership(...args: any[]): Promise<ContractTransaction>;
}

export enum ViolationType {
  Owner = 'Owner',
}

export interface OwnerViolation extends CheckerViolation {
  type: ViolationType.Owner;
  data: {
    contract: Contract;
  };
}

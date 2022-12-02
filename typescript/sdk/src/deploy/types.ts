import { Contract } from 'ethers';

import { Ownable } from '@hyperlane-xyz/core';

import type { ChainMap, ChainName, IChainConnection } from '../types';

export interface CheckerViolation {
  chain: ChainName;
  type: string;
  expected: any;
  actual: any;
  contract?: Contract;
}

export type EnvironmentConfig<Chain extends ChainName> = ChainMap<
  Chain,
  IChainConnection
>;

export enum ViolationType {
  Owner = 'Owner',
  NotDeployed = 'NotDeployed',
}

export interface OwnerViolation extends CheckerViolation {
  type: ViolationType.Owner;
  contract: Ownable;
}

export interface NotDeployedViolation extends CheckerViolation {
  type: ViolationType.NotDeployed;
}

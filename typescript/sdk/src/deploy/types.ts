import type { Contract } from 'ethers';

import type {
  AccessControl,
  Ownable,
  TimelockController,
} from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { deployInterchainAccount } from '../middleware/account/InterchainAccount.js';
import { AccountConfig } from '../middleware/account/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import type { ChainName } from '../types.js';

export type Owner = Address | AccountConfig;

export type OwnableConfig<Keys extends PropertyKey = PropertyKey> = {
  owner: Owner;
  ownerOverrides?: Partial<Record<Keys, Address>>;
};

export async function resolveOrDeployAccountOwner(
  multiProvider: MultiProvider,
  chain: ChainName,
  owner: Owner,
): Promise<Address> {
  if (typeof owner === 'string') {
    return owner;
  } else {
    if (!owner.localRouter) {
      throw new Error('localRouter is required for AccountConfig');
    }
    // submits a transaction to deploy an interchain account if the owner is an AccountConfig and the ICA isn't not deployed yet
    return await deployInterchainAccount(multiProvider, chain, owner);
  }
}

export function isOwnableConfig(config: object): config is OwnableConfig {
  return 'owner' in config;
}

export interface CheckerViolation {
  chain: ChainName;
  type: string;
  expected: any;
  actual: any;
  contract?: Contract;
}

export enum ViolationType {
  Owner = 'Owner',
  NotDeployed = 'NotDeployed',
  BytecodeMismatch = 'BytecodeMismatch',
  ProxyAdmin = 'ProxyAdmin',
  TimelockController = 'TimelockController',
  AccessControl = 'AccessControl',
  TokenMismatch = 'TokenMismatch',
}

export interface OwnerViolation extends CheckerViolation {
  type: ViolationType.Owner;
  contract: Ownable;
  name: string;
  actual: string;
  expected: string;
}

export interface ProxyAdminViolation extends CheckerViolation {
  type: ViolationType.ProxyAdmin;
  name: string;
}

export interface TimelockControllerViolation extends CheckerViolation {
  type: ViolationType.TimelockController;
  actual: number;
  expected: number;
  contract: TimelockController;
}

export interface AccessControlViolation extends CheckerViolation {
  type: ViolationType.AccessControl;
  role: string;
  account: string;
  actual: boolean;
  expected: boolean;
  contract: AccessControl;
}

export interface NotDeployedViolation extends CheckerViolation {
  type: ViolationType.NotDeployed;
}

export interface BytecodeMismatchViolation extends CheckerViolation {
  type: ViolationType.BytecodeMismatch;
  name: string;
}

export interface TokenMismatchViolation extends CheckerViolation {
  tokenAddress: Address;
}

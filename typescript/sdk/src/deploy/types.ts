import type { Contract } from 'ethers';
import { z } from 'zod';

import type {
  AccessControl,
  Ownable,
  TimelockController,
} from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { DeployedOwnableSchema, OwnableSchema } from '../schemas.js';
import type { ChainName } from '../types.js';

export type OwnableConfig = z.infer<typeof OwnableSchema>;

export type DeployedOwnableConfig = z.infer<typeof DeployedOwnableSchema>;

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
  proxyAddress: Address;
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

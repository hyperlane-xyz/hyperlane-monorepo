import {
  HyperlaneConnectionClient,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types';
import { CheckerViolation } from '../deploy/types';
import { IsmConfig } from '../ism/types';

export type OwnableConfig = {
  owner: Address;
};

export type ForeignDeploymentConfig = {
  foreignDeployment?: Address;
};

export type RouterConfig = ConnectionClientConfig &
  OwnableConfig &
  ForeignDeploymentConfig;

export type GasConfig = {
  gas: number;
};

export type GasRouterConfig = RouterConfig & GasConfig;

export type ProxiedFactories = HyperlaneFactories & {
  proxyAdmin: ProxyAdmin__factory;
};

export type ConnectionClientConfig = {
  mailbox: Address;
  interchainGasPaymaster: Address;
  interchainSecurityModule?: Address | IsmConfig;
};

export enum ConnectionClientViolationType {
  InterchainSecurityModule = 'ConnectionClientIsm',
  Mailbox = 'ConnectionClientMailbox',
  InterchainGasPaymaster = 'ConnectionClientIgp',
}

export interface ConnectionClientViolation extends CheckerViolation {
  type: ConnectionClientViolationType;
  contract: HyperlaneConnectionClient;
  actual: string;
  expected: string;
}

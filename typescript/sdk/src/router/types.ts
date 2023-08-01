import {
  HyperlaneConnectionClient,
  ProxyAdmin__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts';
import { UpgradeConfig } from '../deploy/proxy';
import { CheckerViolation } from '../deploy/types';
import { IsmConfig } from '../ism/types';

export type OwnableConfig = {
  owner: types.Address;
};

export type ForeignDeploymentConfig = {
  foreignDeployment?: types.Address;
};

export type RouterConfig = ConnectionClientConfig &
  OwnableConfig &
  ForeignDeploymentConfig;

export type ProxiedRouterConfig = RouterConfig & Partial<UpgradeConfig>;

export type GasConfig = {
  gas: number;
};

export type GasRouterConfig = RouterConfig & GasConfig;

export type ProxiedFactories = HyperlaneFactories & {
  proxyAdmin: ProxyAdmin__factory;
  timelockController: TimelockController__factory;
};

export const proxiedFactories: ProxiedFactories = {
  proxyAdmin: new ProxyAdmin__factory(),
  timelockController: new TimelockController__factory(),
};

export type ConnectionClientConfig = {
  mailbox: types.Address;
  interchainGasPaymaster: types.Address;
  interchainSecurityModule?: types.Address | IsmConfig;
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

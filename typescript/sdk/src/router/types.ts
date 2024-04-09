import {
  MailboxClient,
  ProxyAdmin__factory,
  Router,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types.js';
import { UpgradeConfig } from '../deploy/proxy.js';
import { CheckerViolation, OwnableConfig } from '../deploy/types.js';
import { IsmConfig } from '../ism/types.js';

export type RouterAddress = {
  router: Address;
};

export type ForeignDeploymentConfig = {
  foreignDeployment?: Address;
};

export type RouterConfig = MailboxClientConfig &
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

// TODO: merge with kunal's hook deployer
type HookConfig = Address;

export type MailboxClientConfig = {
  mailbox: Address;
  hook?: HookConfig;
  interchainSecurityModule?: IsmConfig;
};

export enum ClientViolationType {
  InterchainSecurityModule = 'ClientIsm',
  Mailbox = 'ClientMailbox',
  Hook = 'ClientHook',
}

export interface ClientViolation extends CheckerViolation {
  type: ClientViolationType;
  contract: MailboxClient;
  description?: string;
}

export enum RouterViolationType {
  EnrolledRouter = 'EnrolledRouter',
}

export interface RouterViolation extends CheckerViolation {
  type: RouterViolationType.EnrolledRouter;
  remoteChain: string;
  contract: Router;
  actual: string;
  expected: string;
  description?: string;
}

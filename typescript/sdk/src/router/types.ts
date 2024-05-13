import { z } from 'zod';

import {
  MailboxClient,
  ProxyAdmin__factory,
  Router,
  TimelockController__factory,
} from '@hyperlane-xyz/core';

import type { Address } from '../../../utils/dist/index.js';
import { HyperlaneFactories } from '../contracts/types.js';
import { UpgradeConfig } from '../deploy/proxy.js';
import { CheckerViolation, OwnableConfig } from '../deploy/types.js';

import {
  ForeignDeploymentConfigSchema,
  MailboxClientConfigSchema,
} from './schemas.js';

export type RouterAddress = {
  router: Address;
};

export type ForeignDeploymentConfig = z.infer<
  typeof ForeignDeploymentConfigSchema
>;

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

export type MailboxClientConfig = z.infer<typeof MailboxClientConfigSchema>;

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

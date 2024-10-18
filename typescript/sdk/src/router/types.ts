import { z } from 'zod';

import {
  MailboxClient,
  ProxyAdmin__factory,
  Router,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { Address, AddressBytes32 } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types.js';
import { UpgradeConfig } from '../deploy/proxy.js';
import { CheckerViolation } from '../deploy/types.js';
import { ChainMap } from '../types.js';

import {
  DestinationGasSchema,
  GasRouterConfigSchema,
  MailboxClientConfigSchema,
  RemoteRoutersSchema,
  RouterConfigSchema,
} from './schemas.js';

export type RouterAddress = {
  router: Address;
};

export type MailboxClientConfig = z.infer<typeof MailboxClientConfigSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type GasRouterConfig = z.infer<typeof GasRouterConfigSchema>;

export type ProxiedRouterConfig = RouterConfig & Partial<UpgradeConfig>;
export type ProxiedFactories = HyperlaneFactories & {
  proxyAdmin: ProxyAdmin__factory;
  timelockController: TimelockController__factory;
};

export const proxiedFactories: ProxiedFactories = {
  proxyAdmin: new ProxyAdmin__factory(),
  timelockController: new TimelockController__factory(),
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
  contract: Router;
  routerDiff: ChainMap<{
    actual: AddressBytes32;
    expected: AddressBytes32;
  }>;
  description?: string;
}

export type RemoteRouters = z.infer<typeof RemoteRoutersSchema>;
export type DestinationGas = z.infer<typeof DestinationGasSchema>;

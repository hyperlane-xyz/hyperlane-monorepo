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
import { HookConfigSchema } from '../hook/types.js';
import { IsmConfigSchema } from '../ism/types.js';
import { ZHash } from '../metadata/customZodTypes.js';
import { ChainMap, DeployedOwnableSchema, OwnableSchema } from '../types.js';

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
  MisconfiguredEnrolledRouter = 'MisconfiguredEnrolledRouter',
  MissingRouter = 'MissingRouter',
}

export interface RouterViolation extends CheckerViolation {
  type: RouterViolationType.MisconfiguredEnrolledRouter;
  contract: Router;
  routerDiff: ChainMap<{
    actual: AddressBytes32;
    expected: AddressBytes32;
  }>;
  description?: string;
}

export interface MissingRouterViolation extends CheckerViolation {
  type: RouterViolationType.MissingRouter;
  contract: Router;
  description?: string;
}

export type RemoteRouters = z.infer<typeof RemoteRoutersSchema>;
export type DestinationGas = z.infer<typeof DestinationGasSchema>;

export const MailboxClientConfigSchema = OwnableSchema.extend({
  mailbox: ZHash,
  hook: HookConfigSchema.optional(),
  interchainSecurityModule: IsmConfigSchema.optional(),
});

export const ForeignDeploymentConfigSchema = z.object({
  foreignDeployment: z.string().optional(),
});

export const RemoteRouterDomain = z.string();
export const RemoteRouterRouter = z.object({
  address: z.string().startsWith('0x'),
});
export const RemoteRoutersSchema = z.record(
  RemoteRouterDomain,
  RemoteRouterRouter,
);

export const RouterConfigSchema = MailboxClientConfigSchema.merge(
  ForeignDeploymentConfigSchema,
).merge(
  z.object({
    remoteRouters: RemoteRoutersSchema.optional(),
    proxyAdmin: DeployedOwnableSchema.optional(),
  }),
);

const DestinationGasDomain = z.string();
const DestinationGasAmount = z.string(); // This must be a string type to match Ether's type
export const DestinationGasSchema = z.record(
  DestinationGasDomain,
  DestinationGasAmount,
);
export const GasRouterConfigSchema = RouterConfigSchema.extend({
  gas: z.number().optional(),
  destinationGas: DestinationGasSchema.optional(),
});

import { ethers } from 'ethers';

import { ProxyAdmin, ProxyAdmin__factory, Router } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, HyperlaneFactories } from '../contracts';
import { ProxiedContract, TransparentProxyAddresses } from '../proxy';

export type OwnableConfig = {
  owner: types.Address;
};

export type RouterConfig = ConnectionClientConfig & OwnableConfig;

type GasConfig = {
  gas: number;
};

export type GasRouterConfig = RouterConfig & GasConfig;

export type RouterContracts<RouterContract extends Router = Router> =
  HyperlaneContracts & {
    router: RouterContract;
  };

export type ProxiedRouterContracts<RouterContract extends Router = Router> =
  RouterContracts<RouterContract> & {
    proxyAdmin: ProxyAdmin;
    proxiedRouter: ProxiedContract<RouterContract, TransparentProxyAddresses>;
  };

type RouterFactory<RouterContract extends Router = Router> =
  ethers.ContractFactory & {
    deploy: (...args: any[]) => Promise<RouterContract>;
  };

export type RouterFactories<RouterContract extends Router = Router> =
  HyperlaneFactories & {
    router: RouterFactory<RouterContract>;
  };

export type ProxiedRouterFactories<RouterContract extends Router = Router> =
  RouterFactories<RouterContract> & {
    proxyAdmin: ProxyAdmin__factory;
  };

export type ConnectionClientConfig = {
  mailbox: types.Address;
  interchainGasPaymaster: types.Address;
  interchainSecurityModule?: types.Address;
};

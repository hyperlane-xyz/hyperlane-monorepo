import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

import { ProxiedContract } from '../../proxy';

export type InterchainAccountFactories = {
  interchainAccountRouter: InterchainAccountRouter__factory;
  proxyAdmin: ProxyAdmin__factory;
};

export const interchainAccountFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

export type InterchainAccountContracts = {
  interchainAccountRouter: ProxiedContract<InterchainAccountRouter>;
  proxyAdmin: ProxyAdmin;
};

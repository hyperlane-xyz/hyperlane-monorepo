import {
  InterchainQueryRouter,
  InterchainQueryRouter__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

import { ProxiedContract } from '../../proxy';

export type InterchainQueryFactories = {
  interchainQueryRouter: InterchainQueryRouter__factory;
  proxyAdmin: ProxyAdmin__factory;
};

export const interchainQueryFactories = {
  interchainQueryRouter: new InterchainQueryRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

export type InterchainQueryContracts = {
  interchainQueryRouter: ProxiedContract<InterchainQueryRouter>;
  proxyAdmin: ProxyAdmin;
};

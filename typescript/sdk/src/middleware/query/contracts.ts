import {
  InterchainQueryRouter__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

export const interchainQueryFactories = {
  interchainQueryRouter: new InterchainQueryRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

export type InterchainQueryFactories = typeof interchainQueryFactories;

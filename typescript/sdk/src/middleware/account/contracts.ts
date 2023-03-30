import {
  InterchainAccountRouter__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

export const interchainAccountFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

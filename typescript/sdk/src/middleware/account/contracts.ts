import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';

export const interchainAccountFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
};

export type InterchainAccountFactories = typeof interchainAccountFactories;

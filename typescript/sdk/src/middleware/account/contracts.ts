import {
  InterchainAccountRouter__factory,
  MinimalInterchainAccountRouter__factory,
} from '@hyperlane-xyz/core';

export const interchainAccountFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
};

export const minimalInterchainAccountFactories = {
  interchainAccountRouter: new MinimalInterchainAccountRouter__factory(),
};

export type InterchainAccountFactories = typeof interchainAccountFactories;

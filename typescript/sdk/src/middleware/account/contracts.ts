import {
  InterchainAccountIsm__factory,
  InterchainAccountRouter__factory,
} from '@hyperlane-xyz/core';

export const interchainAccountFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
  interchainAccountIsm: new InterchainAccountIsm__factory(),
};

export type InterchainAccountFactories = typeof interchainAccountFactories;

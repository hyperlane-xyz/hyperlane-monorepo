import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { InterchainAccountRouter__factory as TronInterchainAccountRouter__factory } from '@hyperlane-xyz/tron-sdk';

export const interchainAccountFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
};

// Tron factories compiled with 0x41 Create2 prefix for TVM compatibility
export const tronInterchainAccountFactories = {
  interchainAccountRouter: new TronInterchainAccountRouter__factory(),
};

export type InterchainAccountFactories = typeof interchainAccountFactories;

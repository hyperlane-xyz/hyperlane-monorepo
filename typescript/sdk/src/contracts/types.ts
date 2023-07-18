import type { ethers } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import type { ChainMap } from '../types';

export type AddressesMap = {
  [key: string]: types.Address;
};

export type HyperlaneFactories = {
  [key: string]: ethers.ContractFactory;
};

export type HyperlaneContracts<F extends HyperlaneFactories> = {
  [P in keyof F]: Awaited<ReturnType<F[P]['deploy']>>;
};

export type HyperlaneContractsMap<F extends HyperlaneFactories> = ChainMap<
  HyperlaneContracts<F>
>;

export type HyperlaneAddresses<F extends HyperlaneFactories> = {
  [P in keyof F]: types.Address;
};

export type HyperlaneAddressesMap<F extends HyperlaneFactories> = ChainMap<
  HyperlaneAddresses<F>
>;

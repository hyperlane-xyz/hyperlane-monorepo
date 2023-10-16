import type { ethers } from 'ethers';

import type { Address } from '@hyperlane-xyz/utils';

import type { ChainMap } from '../types';

export type AddressesMap = {
  [key: string]: Address;
};

export type HyperlaneFactories = {
  [key: string]: ethers.ContractFactory;
};

export type HyperlaneContracts<F extends HyperlaneFactories> = {
  [P in keyof F]: Awaited<ReturnType<F[P]['deploy']>>;
};

export type HyperlaneContractsMap<F extends HyperlaneFactories> = ChainMap<
  HyperlaneContracts<F>
  // HyperlaneContracts<F> | ChainMap<HyperlaneContracts<F>>
>;

export type HyperlaneAddresses<F extends HyperlaneFactories> = {
  [P in keyof F]: Address;
};

// export type NestedHyperlaneAddresses<F extends HyperlaneFactories> = {
//   [P in keyof F]: Address | NestedHyperlaneAddresses<F>;
// };

// export type NestedHyperlaneAddresses<F extends HyperlaneFactories> = HyperlaneAddresses<F> | ChainMap<HyperlaneAddresses<F>>;

export type HyperlaneAddressesMap<F extends HyperlaneFactories> = ChainMap<
  // HyperlaneAddresses<F> | ChainMap<HyperlaneAddresses<F>>
  HyperlaneAddresses<F>
>;

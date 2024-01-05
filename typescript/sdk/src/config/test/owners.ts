import { Address } from '@hyperlane-xyz/utils';

import { ChainMap } from '../../types';

import { testChainNames } from './chains';

// Owner is hardhat account 0
const OWNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const owners: ChainMap<Address> = Object.fromEntries(
  testChainNames.map((chain) => [chain, OWNER_ADDRESS]),
);

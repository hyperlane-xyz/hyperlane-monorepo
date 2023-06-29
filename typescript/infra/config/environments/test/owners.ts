import { ChainMap } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { chainNames } from './chains';

// Owner is hardhat account 0
const OWNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const owners: ChainMap<types.Address> = Object.fromEntries(
  chainNames.map((chain) => [chain, OWNER_ADDRESS]),
);

// hooks only need test1 and test2
export const ownersForHooks: ChainMap<types.Address> = Object.fromEntries(
  chainNames
    .filter((chain) => chain === 'test1' || chain === 'test2')
    .map((chain) => [chain, OWNER_ADDRESS]),
);

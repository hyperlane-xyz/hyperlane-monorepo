import { ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';

import { chainNames } from './chains.js';

// Owner is hardhat account 0
const OWNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const owners: ChainMap<OwnableConfig> = Object.fromEntries(
  chainNames.map((chain) => [chain, { owner: OWNER_ADDRESS }]),
);

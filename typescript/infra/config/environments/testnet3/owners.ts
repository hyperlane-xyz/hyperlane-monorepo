import { ChainMap } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { chainNames } from './chains';

const DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';

export const owners: ChainMap<types.Address> = Object.fromEntries(
  chainNames.map((chain) => [chain, DEPLOYER_ADDRESS]),
);

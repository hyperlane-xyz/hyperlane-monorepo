import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { supportedChainNames } from './chains';

const DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';

export const owners: ChainMap<Address> = Object.fromEntries(
  supportedChainNames.map((chain) => [chain, DEPLOYER_ADDRESS]),
);

import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { ethereumChainNames } from './chains';

const ETHEREUM_DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';
// const SEALEVEL_DEPLOYER_ADDRESS = '6DjHX6Ezjpq3zZMZ8KsqyoFYo1zPSDoiZmLLkxD4xKXS';

export const owners: ChainMap<Address> = {
  ...Object.fromEntries(
    ethereumChainNames.map((chain) => [chain, ETHEREUM_DEPLOYER_ADDRESS]),
  ),
  // [chainMetadata.solanadevnet.name]: SEALEVEL_DEPLOYER_ADDRESS,
};

import { ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';

import { supportedChainNames } from '../testnet4/chains.js';

const ETHEREUM_DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';
// const SEALEVEL_DEPLOYER_ADDRESS = '6DjHX6Ezjpq3zZMZ8KsqyoFYo1zPSDoiZmLLkxD4xKXS';

export const owners: ChainMap<OwnableConfig> = {
  ...Object.fromEntries(
    supportedChainNames.map((chain) => [
      chain,
      { owner: ETHEREUM_DEPLOYER_ADDRESS },
    ]),
  ),
  // [chainMetadata.solanadevnet.name]: SEALEVEL_DEPLOYER_ADDRESS,
};

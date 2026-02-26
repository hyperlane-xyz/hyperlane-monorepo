import {
  ChainMap,
  HookType,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

const SOLANA_FOREIGN_DEPLOYMENT =
  'B1dBmaEFGMbLvNn3UsrayxQBTVF7K9XFBS66M1csyUz1';

const tokens = {
  bsc: '0x2a48a41301E6635DF9E65B80063Ff84677142619',
  polygon: '0x9b765735C82BB00085e9DBF194F20E3Fa754258E',
  solanamainnet: 'CDwKAreA1ipd1hUDBKsfVXVFWqNEeGDdvmZ7RHdiQk1U',
};

const owners = {
  arbitrum: '0xAfD0Ac442c6d7E0f34476a10d4ba0bD7cffb4c72',
  bsc: '0xAfD0Ac442c6d7E0f34476a10d4ba0bD7cffb4c72',
  carrchain: '0xAfD0Ac442c6d7E0f34476a10d4ba0bD7cffb4c72',
  polygon: '0xAfD0Ac442c6d7E0f34476a10d4ba0bD7cffb4c72',
  solanamainnet: '5HDsXasp9a3bTdT2YyXookfBQtLKtshQXyWyMv1mZKx7',
};

export const getCarrChainCARRWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    owner: owners.arbitrum,
    type: TokenType.synthetic,
  };

  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    owner: owners.bsc,
    type: TokenType.collateral,
    token: tokens.bsc,
  };

  const carrchain: HypTokenRouterConfig = {
    ...routerConfig.carrchain,
    owner: owners.carrchain,
    type: TokenType.native,
    hook: {
      type: HookType.AGGREGATION,
      hooks: [
        {
          type: HookType.MAILBOX_DEFAULT,
        },
        {
          type: HookType.PAUSABLE,
          paused: false,
          owner: owners.carrchain,
        },
      ],
    },
  };

  const polygon: HypTokenRouterConfig = {
    ...routerConfig.polygon,
    owner: owners.polygon,
    type: TokenType.collateral,
    token: tokens.polygon,
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    owner: owners.solanamainnet,
    type: TokenType.collateral,
    token: tokens.solanamainnet,
    foreignDeployment: SOLANA_FOREIGN_DEPLOYMENT,
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  };

  return {
    arbitrum,
    bsc,
    carrchain,
    polygon,
    solanamainnet,
  };
};

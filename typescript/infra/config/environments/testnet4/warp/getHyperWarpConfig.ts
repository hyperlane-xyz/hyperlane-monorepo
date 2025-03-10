import {
  HypTokenRouterConfig,
  TokenMetadata,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { ETHEREUM_DEPLOYER_ADDRESS } from '../owners.js';

const mailboxes = {
  sepolia: '0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766',
  arbitrumsepolia: '0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8',
  basesepolia: '0x6966b0E55883d49BFB24539356a2f8A673E02039',
  optimismsepolia: '0x6966b0E55883d49BFB24539356a2f8A673E02039',
};

const initialSupply = {
  sepolia: '1000000000000000000', // 1e18
  arbitrumsepolia: 0,
  basesepolia: 0,
  optimismsepolia: 0,
};

const warpRouteConfig = objMap(
  initialSupply,
  (chain, amount): HypTokenRouterConfig => {
    const tokenConfig: TokenMetadata = {
      // use VYPER as the token name and symbol for obfuscation
      name: 'Vyper Token',
      symbol: 'VYPER',
      decimals: 18,
      totalSupply: amount,
    };

    return {
      type: TokenType.synthetic,
      owner: ETHEREUM_DEPLOYER_ADDRESS,
      mailbox: mailboxes[chain],
      ...tokenConfig,
    };
  },
);

console.log(JSON.stringify(warpRouteConfig));

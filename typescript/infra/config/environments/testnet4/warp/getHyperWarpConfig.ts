import { HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { ETHEREUM_DEPLOYER_ADDRESS } from '../owners.js';

// use VYPER alias for obfuscation
const tokenConfig = {
  name: 'Vyper Token',
  symbol: 'VYPER',
  decimals: 18,
};

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

const COLLATERAL_CHAIN = 'sepolia';

const warpRouteConfig = objMap(
  initialSupply,
  (chain, amount): HypTokenRouterConfig => ({
    type:
      chain === COLLATERAL_CHAIN ? TokenType.hyperToken : TokenType.synthetic,
    owner: ETHEREUM_DEPLOYER_ADDRESS,
    mailbox: mailboxes[chain],
    totalSupply: amount,
    ...tokenConfig,
  }),
);

console.log(JSON.stringify(warpRouteConfig));

const stakedWarpRouteConfig = objMap(
  mailboxes,
  (chain, mailbox): HypTokenRouterConfig => {
    const config = {
      owner: ETHEREUM_DEPLOYER_ADDRESS,
      mailbox,
      name: `Staked ${tokenConfig.name}`,
      symbol: `st${tokenConfig.symbol}`,
      decimals: tokenConfig.decimals,
    };

    if (chain === COLLATERAL_CHAIN) {
      return {
        type: TokenType.collateralVaultRebase,
        // symbiotic compound staker rewards
        token: '0x2aDe4CDD4DCECD4FdE76dfa99d61bC8c1940f2CE',
        ...config,
      };
    } else {
      return {
        type: TokenType.syntheticRebase,
        collateralChainName: COLLATERAL_CHAIN,
        ...config,
      };
    }
  },
);

console.log(JSON.stringify(stakedWarpRouteConfig));

import { HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

const tokenConfig = {
  name: 'Hyper Token',
  symbol: 'HYPER',
  decimals: 18,
};

const mailboxes = {
  sepolia: '0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766',
  arbitrumsepolia: '0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8',
  basesepolia: '0x6966b0E55883d49BFB24539356a2f8A673E02039',
  optimismsepolia: '0x6966b0E55883d49BFB24539356a2f8A673E02039',
};

const owners = {
  sepolia: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  // get-owner-ica output for sepolia owner
  arbitrumsepolia: '0xDFd80Ae8E7282B372798fEF8240E5f10Ed37EAe8',
  basesepolia: '0xb3F1ec53A32dC92065285fF57db946ceF6E33971',
  optimismsepolia: '0x6B72e2aCCd5Af2C0Be4CDDA4fE193e30263e8052',
};

const initialSupply = {
  sepolia: '1000000000000000000', // 1e18
  arbitrumsepolia: 0,
  basesepolia: 0,
  optimismsepolia: 0,
};

const COLLATERAL_CHAIN = 'sepolia';

export const warpRouteConfig = objMap(
  initialSupply,
  (chain, amount): HypTokenRouterConfig => ({
    type:
      chain === COLLATERAL_CHAIN ? TokenType.hyperToken : TokenType.synthetic,
    owner: owners[chain],
    mailbox: mailboxes[chain],
    totalSupply: amount,
    ...tokenConfig,
  }),
);

// TODO: configure proxy admin to be reused?
export const stakedWarpRouteConfig = objMap(
  warpRouteConfig,
  (chain, config): HypTokenRouterConfig => {
    const tokenConfig = {
      name: `Staked ${config.name}`,
      symbol: `st${config.symbol}`,
    };

    if (chain === COLLATERAL_CHAIN) {
      return {
        ...config,
        ...tokenConfig,
        type: TokenType.collateralVaultRebase,
        // symbiotic compound staker rewards
        token: '0x2aDe4CDD4DCECD4FdE76dfa99d61bC8c1940f2CE',
      };
    } else {
      return {
        ...config,
        ...tokenConfig,
        type: TokenType.syntheticRebase,
        collateralChainName: COLLATERAL_CHAIN,
      };
    }
  },
);

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

// Deployment scope: the EVM legs of CROSS/moonpay-staging that hold both a
// USDC-side and USDT-side CrossCollateralRouter (mutually cross-enrolled), so a
// same-chain USDC->USDT local rebalance is possible.
const deploymentChains = [
  'ethereum',
  'base',
  'arbitrum',
  'polygon',
  'bsc',
] as const;

export type DeploymentChain = (typeof deploymentChains)[number];

// Owner of the deployed bridges. Matches the CROSS/moonpay-staging router owner
// (Troy's staging deployer key) so the same key can wire the bridge onto the
// source routers (addRebalancer / addBridge / addRebalanceTarget).
const OWNER = '0x1cFd6A81e98de59e3eeB3AE35c3cb13FCb586E1E';

// USDC-side CrossCollateralRouter per chain — the immutable source router each
// bridge binds to. Read from the deployed CROSS/moonpay-staging registry config.
const sourceRoutersByChain: Record<DeploymentChain, string> = {
  ethereum: '0xB58C85C143f2032A77e2C2B08603453ebA6C12aF',
  base: '0x146Fb3Fcc2C9F547Ee4f85A5b0497274cBD380D0',
  arbitrum: '0x9fb176528AdF0Bb7524CE752B2345C80eD24243F',
  polygon: '0xa539EF6eF471c2D00d258540AB0bc38eD0B1F2ab',
  bsc: '0x3382D9253eE54d49A90cBA41Cfc7b2704e713cEf',
};

// AtomicLocalRebalancingBridge is a bare ITokenBridge adapter that resolves the
// source/destination tokens dynamically at call time, so the token metadata
// below is cosmetic (only used to satisfy the warp-deploy metadata pipeline).
export const getCrossMoonpayStagingLocalBridgeWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  Object.fromEntries(
    deploymentChains.map((chain) => [
      chain,
      {
        ...routerConfig[chain],
        owner: OWNER,
        type: TokenType.atomicLocalRebalancing,
        sourceRouter: sourceRoutersByChain[chain],
        decimals: 6,
        name: 'Moonpay Staging Local Rebalancing Bridge (USDC)',
        symbol: 'mpsALRB',
      },
    ]),
  );

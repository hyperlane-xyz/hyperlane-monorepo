import {
  ChainMap,
  HypTokenConfig,
  HypTokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

const owners = {
  ethereum: '0x11BEBBf509248735203BAAAe90c1a27EEE70D567',
  superseed: '0x6652010BaCE855DF870D427daA6141c313994929',
  base: '0x11BEBBf509248735203BAAAe90c1a27EEE70D567',
  ink: '0x11BEBBf509248735203BAAAe90c1a27EEE70D567',
  optimism: '0x11BEBBf509248735203BAAAe90c1a27EEE70D567',
  arbitrum: '0x11BEBBf509248735203BAAAe90c1a27EEE70D567',
  solanamainnet: 'JAPPhnuChtzCGmskmFdurvAxENWwcAqXCV5Jn5SSiuWE',
};

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

const CONTRACT_VERSION = '8.0.0';

export const getEthereumSuperseedUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const registry = getRegistry();
  const mainnetCCTP = registry.getWarpRoute(WarpRouteIds.MainnetCCTP);

  assert(mainnetCCTP, 'MainnetCCTP warp route not found');

  const metadata = registry.getMetadata();

  const cctpBridges = Object.fromEntries(
    mainnetCCTP.tokens.map(({ chainName, addressOrDenom }) => [
      chainName,
      addressOrDenom!,
    ]),
  );

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    contractVersion: CONTRACT_VERSION,
    allowedRebalancers: [REBALANCER],
    allowedRebalancingBridges: {
      [metadata.arbitrum.domainId]: [{ bridge: cctpBridges.ethereum }],
      [metadata.base.domainId]: [{ bridge: cctpBridges.ethereum }],
      [metadata.optimism.domainId]: [{ bridge: cctpBridges.ethereum }],
    },
  };

  const superseed: HypTokenRouterConfig = {
    ...routerConfig.superseed,
    owner: owners.superseed,
    type: TokenType.collateralFiat,
    token: '0xc316c8252b5f2176d0135ebb0999e99296998f2e',
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    owner: owners.arbitrum,
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    contractVersion: CONTRACT_VERSION,
    allowedRebalancers: [REBALANCER],
    allowedRebalancingBridges: {
      [metadata.ethereum.domainId]: [{ bridge: cctpBridges.arbitrum }],
      [metadata.base.domainId]: [{ bridge: cctpBridges.arbitrum }],
      [metadata.optimism.domainId]: [{ bridge: cctpBridges.arbitrum }],
    },
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    owner: owners.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    contractVersion: CONTRACT_VERSION,
    allowedRebalancers: [REBALANCER],
    allowedRebalancingBridges: {
      [metadata.ethereum.domainId]: [{ bridge: cctpBridges.base }],
      [metadata.arbitrum.domainId]: [{ bridge: cctpBridges.base }],
      [metadata.optimism.domainId]: [{ bridge: cctpBridges.base }],
    },
  };

  const optimism: HypTokenRouterConfig = {
    ...routerConfig.optimism,
    owner: owners.optimism,
    type: TokenType.collateral,
    token: tokens.optimism.USDC,
    contractVersion: CONTRACT_VERSION,
    allowedRebalancers: [REBALANCER],
    allowedRebalancingBridges: {
      [metadata.ethereum.domainId]: [{ bridge: cctpBridges.optimism }],
      [metadata.base.domainId]: [{ bridge: cctpBridges.optimism }],
      [metadata.arbitrum.domainId]: [{ bridge: cctpBridges.optimism }],
    },
  };

  const ink: HypTokenRouterConfig = {
    ...routerConfig.ink,
    owner: owners.ink,
    type: TokenType.collateral,
    token: tokens.ink.USDCe,
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    owner: owners.solanamainnet,
    type: TokenType.collateral,
    token: tokens.solanamainnet.USDC,
    foreignDeployment: '7aM3itqXToHXhdR97EwJjZc7fay6uBszhUs1rzJm3tto',
  };

  return {
    ethereum,
    superseed,
    arbitrum,
    base,
    optimism,
    ink,
    solanamainnet,
  };
};

export const getEthereumSuperseedUSDCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ethereum, superseed, arbitrum, base, optimism, ink, solanamainnet } =
    await getEthereumSuperseedUSDCWarpConfig(routerConfig);

  return {
    ethereum,
    arbitrum,
    base,
    optimism,
    ink,
    solanamainnet: {
      ...solanamainnet,
      foreignDeployment: '8UUnM8wheNwAf3KM65Yx72Mq8mSAHf33GUwEp3MAyQX1',
    },
    superseed: {
      ...superseed,
      token: '0x99a38322cAF878Ef55AE4d0Eda535535eF8C7960',
    } as Extract<HypTokenConfig, { type: TokenType.collateralFiat }>,
  };
};

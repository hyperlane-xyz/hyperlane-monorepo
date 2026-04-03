import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { WarpRouteIds } from '../warpIds.js';

import {
  getFixedRoutingFeeConfigForChain,
  getRebalancingUSDCConfigForChain,
  getSyntheticTokenConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

type DeploymentChains<T> = {
  arbitrum: T;
  base: T;
  ethereum: T;
  mantra: T;
  hyperevm: T;
};

const SAFE_OWNER_ADDRESS = '0x66B6FF38b988759E57509f00c7B9717b1a94DA4D';

// SAFE wallets from the team
const ownersByChain: DeploymentChains<Address> = {
  arbitrum: SAFE_OWNER_ADDRESS,
  base: SAFE_OWNER_ADDRESS,
  ethereum: SAFE_OWNER_ADDRESS,
  mantra: SAFE_OWNER_ADDRESS,
  // ICA deployed with the ethereum safe as owner
  hyperevm: '0x85E9F6f98163af72f44E5dEb64bf26e110D3ea82',
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
  [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
);

const v1rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
  [WarpRouteIds.MainnetCCTPV1],
);

const WARP_FEE_BPS = 10;

export const getMantraUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const deployConfig = {
    // collateral chains have fees between them
    arbitrum: getRebalancingUSDCConfigForChain(
      'arbitrum',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
      getFixedRoutingFeeConfigForChain(
        'arbitrum',
        ownersByChain,
        ['base', 'ethereum', 'hyperevm'],
        WARP_FEE_BPS,
      ),
    ),
    base: getRebalancingUSDCConfigForChain(
      'base',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
      getFixedRoutingFeeConfigForChain(
        'base',
        ownersByChain,
        ['arbitrum', 'ethereum', 'hyperevm'],
        WARP_FEE_BPS,
      ),
    ),
    ethereum: getRebalancingUSDCConfigForChain(
      'ethereum',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
      getFixedRoutingFeeConfigForChain(
        'ethereum',
        ownersByChain,
        ['arbitrum', 'base', 'hyperevm'],
        WARP_FEE_BPS,
      ),
    ),
    hyperevm: getRebalancingUSDCConfigForChain(
      'hyperevm',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
      getFixedRoutingFeeConfigForChain(
        'hyperevm',
        ownersByChain,
        ['arbitrum', 'base', 'ethereum'],
        WARP_FEE_BPS,
      ),
    ),
    mantra: getSyntheticTokenConfigForChain(
      'mantra',
      routerConfig,
      ownersByChain,
      getFixedRoutingFeeConfigForChain(
        'mantra',
        ownersByChain,
        ['arbitrum', 'base', 'ethereum', 'hyperevm'],
        WARP_FEE_BPS,
      ),
    ),
  } satisfies DeploymentChains<HypTokenRouterConfig>;

  for (const currentChain of Object.keys(ownersByChain)) {
    const config = deployConfig[currentChain as keyof typeof ownersByChain];
    assert(
      config.type === TokenType.collateral,
      `Expected config to be defined on chain ${currentChain}`,
    );

    config.contractVersion = '11.1.0';
  }

  // Inject the cctpV1 config for existing chains until the route is updated to use
  // cctpv2 and set the contract version
  const cctpV1Chains: (keyof DeploymentChains<unknown>)[] = [
    'arbitrum',
    'base',
    'ethereum',
  ];
  for (const currentChain of cctpV1Chains) {
    const config = deployConfig[currentChain];
    assert(
      config.type === TokenType.collateral,
      `Expected config to be collateral on chain ${currentChain}`,
    );

    const v1Rebalancing = v1rebalancingConfigByChain[currentChain];
    assert(
      v1Rebalancing,
      `Expected v1 rebalancing bridge config to be defined for chain ${currentChain}`,
    );

    for (const otherChain of cctpV1Chains.filter((c) => c !== currentChain)) {
      assert(
        config?.allowedRebalancingBridges?.[otherChain],
        `Expected rebalancing config to be defined on chain ${currentChain} for chain ${otherChain}`,
      );
      config.allowedRebalancingBridges[otherChain] = [
        ...v1Rebalancing.allowedRebalancingBridges[otherChain],
        ...config.allowedRebalancingBridges[otherChain],
      ];
    }
  }

  return deployConfig;
};

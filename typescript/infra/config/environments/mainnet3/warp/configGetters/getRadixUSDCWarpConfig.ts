import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { WarpRouteIds } from '../warpIds.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const owners = {
  // EVM legs are owned by the Radix Safe on ethereum and its ICAs on
  // arbitrum/base for collateral recovery.
  ethereum: '0x995A921d333029512aa166885856c8AF760E9381',
  arbitrum: '0x72B5EC6EEE0B358FB1F77d40D469a63530A91DB3',
  base: '0x1f6E345a67b3BD0277410887d732b2d0E4699d11',
  radix: 'account_rdx1280taxhhnuek02y59yapsg4kjtux954qkyufpwmy4dlfcxdrjzr7fj',
  solanamainnet: 'GvjSzPttfE3dimBFZMKFhg7Yq3C5Jz17SrpE1L4nbR2F',
};

const deploymentChains = [
  'arbitrum',
  'base',
  'ethereum',
  'radix',
  'solanamainnet',
];

export const getRadixUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfig = getUSDCRebalancingBridgesConfigFor(
    deploymentChains,
    [
      WarpRouteIds.MainnetCCTPV1,
      WarpRouteIds.MainnetCCTPV2Standard,
      WarpRouteIds.MainnetCCTPV2Fast,
    ],
  );

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    decimals: 6,
    owner: owners.ethereum,
    proxyAdmin: { owner: owners.ethereum },
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: {
      type: IsmType.AGGREGATION,
      threshold: 3,
      modules: [
        {
          type: IsmType.MAILBOX_DEFAULT,
        },
        {
          type: IsmType.BLACKLIST,
          owner: owners.ethereum,
          blacklistedIds: [
            '0x8960c5e41eb0d91973140ebc196892f5f07f512dd86047e8536e71424462c5d3',
          ],
        },
        {
          type: IsmType.PAUSABLE,
          owner: '0x60Cc386C85717CB51C2827A75e14826883dF5da4',
          paused: false,
        },
      ],
    },
    ...rebalancingConfig.ethereum,
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    decimals: 6,
    owner: owners.arbitrum,
    proxyAdmin: { owner: owners.arbitrum },
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    ...rebalancingConfig.arbitrum,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    decimals: 6,
    owner: owners.base,
    proxyAdmin: { owner: owners.base },
    type: TokenType.collateral,
    token: tokens.base.USDC,
    ...rebalancingConfig.base,
  };

  const radix: HypTokenRouterConfig = {
    ...routerConfig.radix,
    owner: owners.radix,
    type: TokenType.synthetic,
    symbol: 'hUSDC',
    name: 'Hyperlane USD Coin',
    foreignDeployment:
      'component_rdx1crvhu42czzpvkh556228sc5xk7uz69yvwcsqn23u5yy65pea0w02l0',
    gas: 30_000_000,
    decimals: 6,
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    decimals: 6,
    owner: owners.solanamainnet,
    type: TokenType.collateral,
    token: tokens.solanamainnet.USDC,
    foreignDeployment: 'mSjeF19MEyUto4RejyPeL6SGb2eDevNfYESaHBeQb9z',
    gas: 300_000,
  };

  return {
    arbitrum,
    base,
    ethereum,
    radix,
    solanamainnet,
  };
};

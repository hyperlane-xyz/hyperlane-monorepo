import {
  ChainMap,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
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
  aleo: 'aleo1xvxtrlg5a4kze76xejvmremj8qnkkquqtfpece47csw64pegeyqq36xvtr',
  arbitrum: '0x63C65aFC66C7247a3d43197744Da7F5838ACbf77',
  avalanche: '0x117f4a84f98b3C8BEF00a2371672031694C1Fa0A',
  base: '0xc88297c52BED07aecAec13BD3bB21647C319a73d',
  bsc: '0x157515A5Fe21FBC4e22479B5FA59344D0bC8bc58',
  ethereum: '0x738Bb9f27B5757797ba730390b4e43A9F4C2A011',
  optimism: '0x17e9199682D987D61784F8105018fa30e04Aa886',
  polygon: '0xac4AB5850b8dE9c07A2756c1c79266aB36183822',
  solanamainnet: 'ABJnd4eWexNte9GYy21ud5hvSwFKWedveP6GCFxXKkCw',
};

// Customer paused Aleo-bound transfers on-chain while keeping other routes live.
const pausedAleoHook = (owner: string): HookConfig => ({
  type: HookType.FALLBACK_ROUTING,
  owner,
  fallback: {
    type: HookType.MAILBOX_DEFAULT,
  },
  domains: {
    aleo: {
      type: HookType.PAUSABLE,
      owner,
      paused: true,
    },
  },
});

export const getAleoUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfig = getUSDCRebalancingBridgesConfigFor(
    Object.keys(owners),
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const defaultNameSymbolScale = {
    name: 'USD Coin',
    symbol: 'USDC',
    scale: 1000000000000,
  };

  const aleo: HypTokenRouterConfig = {
    ...routerConfig.aleo,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.aleo,
    type: TokenType.synthetic,
    gas: 60_000,
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.arbitrum,
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    ...rebalancingConfig.arbitrum,
    hook: pausedAleoHook(owners.arbitrum),
  };

  const avalanche: HypTokenRouterConfig = {
    ...routerConfig.avalanche,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.avalanche,
    type: TokenType.collateral,
    token: tokens.avalanche.USDC,
    ...rebalancingConfig.avalanche,
    hook: pausedAleoHook(owners.avalanche),
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    ...rebalancingConfig.base,
    hook: pausedAleoHook(owners.base),
  };

  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    name: 'USD Coin',
    symbol: 'USDC',
    scale: 1,
    decimals: 18,
    owner: owners.bsc,
    type: TokenType.collateral,
    token: tokens.bsc.USDC,
    hook: pausedAleoHook(owners.bsc),
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    ...rebalancingConfig.ethereum,
    hook: pausedAleoHook(owners.ethereum),
  };

  const optimism: HypTokenRouterConfig = {
    ...routerConfig.optimism,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.optimism,
    type: TokenType.collateral,
    token: tokens.optimism.USDC,
    ...rebalancingConfig.optimism,
    hook: pausedAleoHook(owners.optimism),
  };

  const polygon: HypTokenRouterConfig = {
    ...routerConfig.polygon,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.polygon,
    type: TokenType.collateral,
    token: tokens.polygon.USDC,
    ...rebalancingConfig.polygon,
    hook: pausedAleoHook(owners.polygon),
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.solanamainnet,
    type: TokenType.collateral,
    token: tokens.solanamainnet.USDC,
    foreignDeployment: 'EiUymjh3vJ2486ozY24s1A1YWXoH6QnSGjWuP95ph35G',
    gas: 300_000,
    // Customer unenrolled Aleo on-chain from Solana while keeping other routers.
    remoteRouters: {
      1: { address: '0x78Ac7FECD1857f5BEEe98AB39096c9781F976D97' },
      10: { address: '0x1FdA66FA15A261F01F1E09228D41bD0A806d7529' },
      56: { address: '0x5284D803a4563DC5eE83feA80c688b096d70eb75' },
      137: { address: '0x1FdA66FA15A261F01F1E09228D41bD0A806d7529' },
      8453: { address: '0xB46930ca998587A95D9Ee000FA73A071ADD56B64' },
      42161: { address: '0x1FdA66FA15A261F01F1E09228D41bD0A806d7529' },
      43114: { address: '0x1FdA66FA15A261F01F1E09228D41bD0A806d7529' },
    },
    destinationGas: {
      '1634493807': '64000', // aleo
      '42161': '68000', // arbitrum
      '43114': '68000', // avalanche
      '8453': '68000', // base
      '56': '68000', // bsc
      '1': '68000', // ethereum
      '10': '68000', // optimism
      '137': '68000', // polygon
    },
  };

  return {
    aleo,
    arbitrum,
    avalanche,
    base,
    bsc,
    ethereum,
    optimism,
    polygon,
    solanamainnet,
  };
};

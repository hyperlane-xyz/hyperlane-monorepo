import {
  ChainMap,
  ChainName,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import fastpathIsms from '../../fastpath/isms.json' with { type: 'json' };
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { WARP_FEES_TURNKEY_OWNER } from '../../governance/utils.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { usdcTokenAddresses } from '../cctp.js';
import { WarpRouteIds } from '../warpIds.js';
import {
  buildCrossCollateralRoutingFee,
  getMoonpayCrossCollateralRouters,
  MOONPAY_ROUTE_CHAINS,
} from './moonpay.js';
import {
  getRebalancingBridgesConfigFor,
  getUSDCRebalancingBridgesConfigFor,
  mergeAllowedBridges,
  REBALANCER,
} from './utils.js';

const FASTPATH_CHAINS = [
  'arbitrum',
  'base',
  'bsc',
  'citrea',
  'ethereum',
  'katana',
  'polygon',
] as const;
type FastpathChain = (typeof FASTPATH_CHAINS)[number];
const FASTPATH_ISM_ADDRESSES = fastpathIsms as Record<FastpathChain, string>;

const ROUTE_CHAINS = MOONPAY_ROUTE_CHAINS;
const CCTP_CHAINS = [
  'arbitrum',
  'arc',
  'base',
  'ethereum',
  'polygon',
] as const satisfies readonly ChainName[];
const EVM_CHAINS = ['arbitrum', 'base', 'ethereum', 'polygon'] as const;
type EvmChain = (typeof EVM_CHAINS)[number];
type CctpChain = (typeof CCTP_CHAINS)[number];

const SOLANA_IGP_ADDRESS = 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv';
const SOLANA_XO_TOKEN_MINT = 'xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y';
const SOLANA_XO_NAME = 'XO Cash';
const SOLANA_XO_SYMBOL = 'XO';
const ownersByChain = {
  solanamainnet: 'BNGDJ1h9brgt6FFVd8No1TVAH48Fp44d7jkuydr1URwJ', // Squads multisig
  arbitrum: awIcas.arbitrum,
  arc: awIcas.arc,
  base: awIcas.base,
  bsc: awIcas.bsc,
  citrea: awIcas.citrea,
  ethereum: awSafes.ethereum,
  katana: awIcas.katana,
  polygon: awIcas.polygon,
} as const;

function getCctpFastRouteAddresses(): Record<CctpChain, string> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.MainnetCCTPV2Fast);
  assert(route, 'Mainnet CCTP v2 fast route not found in registry');

  return Object.fromEntries(
    CCTP_CHAINS.map((chain) => {
      const token = route.tokens.find(({ chainName }) => chainName === chain);
      assert(token?.addressOrDenom, `Missing fast route address for ${chain}`);
      return [chain, token.addressOrDenom];
    }),
  ) as Record<CctpChain, string>;
}

function getTBDAAddresses(): Record<
  'arbitrum' | 'base' | 'ethereum' | 'citrea' | 'polygon',
  string
> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDCCitreaIronBridge);
  assert(route, 'CROSS/ctusd-usdc-ironbridge route not found in registry');

  const find = (chain: EvmChain | 'citrea') => {
    const token = route.tokens.find((t) => t.chainName === chain);
    assert(token?.addressOrDenom, `Missing TBDA address for ${chain}`);
    return token.addressOrDenom;
  };

  return {
    arbitrum: find('arbitrum'),
    base: find('base'),
    ethereum: find('ethereum'),
    citrea: find('citrea'),
    polygon: find('polygon'),
  };
}

const CCTP_FAST_ROUTE_ADDRESSES = getCctpFastRouteAddresses();

function getUsdtCrossCollateralRouters(): Record<string, string[]> {
  return getMoonpayCrossCollateralRouters([WarpRouteIds.USDTCitreaMoonpay]);
}

function isCctpChain(chain: ChainName): chain is CctpChain {
  return CCTP_CHAINS.includes(chain as CctpChain);
}

function buildDefaultIsm(owner: string): IsmConfig {
  return {
    type: IsmType.FALLBACK_ROUTING,
    domains: {},
    owner,
  };
}

function buildRemoteIsm(
  local: (typeof ROUTE_CHAINS)[number],
  remote: (typeof ROUTE_CHAINS)[number],
  owner: string,
): IsmConfig {
  if (isCctpChain(local) && isCctpChain(remote)) {
    return CCTP_FAST_ROUTE_ADDRESSES[local];
  }

  const fastpathIsm = FASTPATH_ISM_ADDRESSES[local as FastpathChain];
  if (fastpathIsm && FASTPATH_CHAINS.includes(remote as FastpathChain)) {
    return fastpathIsm;
  }

  return buildDefaultIsm(owner);
}

function buildInterchainSecurityModule(
  local: (typeof ROUTE_CHAINS)[number],
  owner: string,
): IsmConfig | undefined {
  if (local === 'solanamainnet') return undefined;

  return {
    type: IsmType.AGGREGATION,
    threshold: 1,
    modules: [
      {
        type: IsmType.ROUTING,
        owner,
        domains: Object.fromEntries(
          ROUTE_CHAINS.filter((remote) => remote !== local).map((remote) => [
            remote,
            buildRemoteIsm(local, remote, owner),
          ]),
        ),
      } as const,
      buildDefaultIsm(owner),
    ],
  } as const;
}

function buildFastRouteHook(local: CctpChain, owner: string) {
  return {
    type: HookType.FALLBACK_ROUTING,
    owner,
    domains: Object.fromEntries(
      CCTP_CHAINS.filter((remote) => remote !== local).map((remote) => [
        remote,
        {
          type: HookType.AGGREGATION,
          hooks: [
            { type: HookType.MAILBOX_DEFAULT },
            CCTP_FAST_ROUTE_ADDRESSES[local],
          ],
        } as const satisfies HookConfig,
      ]),
    ),
    fallback: { type: HookType.MAILBOX_DEFAULT },
  } as const;
}

function buildHook(local: (typeof ROUTE_CHAINS)[number], owner: string) {
  if (local === 'solanamainnet') {
    return SOLANA_IGP_ADDRESS;
  }

  if (!isCctpChain(local)) return undefined;

  return buildFastRouteHook(local, owner);
}

export async function getUSDCCitreaMoonpayWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const cctpRebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    ['arbitrum', 'base', 'ethereum', 'polygon'],
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const cctpStandardRebalancingConfigByChain =
    getUSDCRebalancingBridgesConfigFor(
      ['arbitrum', 'arc', 'base', 'ethereum', 'polygon'],
      [WarpRouteIds.MainnetCCTPV2Standard],
    );

  const additionalRebalancingConfigByChain = getRebalancingBridgesConfigFor(
    ['arbitrum', 'arc', 'base', 'bsc', 'ethereum', 'polygon'],
    [
      WarpRouteIds.EclipseUSDC,
      WarpRouteIds.ParadexUSDC,
      WarpRouteIds.IgraUSDC,
      WarpRouteIds.RadixUSDC,
    ],
  );

  const tbda = getTBDAAddresses();

  const {
    solanamainnet: solanaOwner,
    arbitrum: arbitrumOwner,
    arc: arcOwner,
    base: baseOwner,
    bsc: bscOwner,
    citrea: citreaOwner,
    ethereum: ethereumOwner,
    katana: katanaOwner,
    polygon: polygonOwner,
  } = ownersByChain;
  const crossCollateralRouters = getUsdtCrossCollateralRouters();

  assert(
    additionalRebalancingConfigByChain.bsc,
    'missing rebalancing config for bsc',
  );

  return {
    solanamainnet: {
      type: TokenType.crossCollateral,
      token: SOLANA_XO_TOKEN_MINT,
      mailbox: routerConfig.solanamainnet.mailbox,
      owner: solanaOwner,
      hook: buildHook('solanamainnet', solanaOwner),
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      name: SOLANA_XO_NAME,
      symbol: SOLANA_XO_SYMBOL,
      decimals: 6,
      crossCollateralRouters,
    },
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDC,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: arbitrumOwner,
      ...cctpRebalancingConfigByChain.arbitrum,
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpRebalancingConfigByChain.arbitrum.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.arbitrum?.allowedRebalancingBridges,
        { citrea: [{ bridge: tbda.arbitrum }] },
        {
          arc: cctpStandardRebalancingConfigByChain.arbitrum
            .allowedRebalancingBridges.arc,
        },
      ),
      hook: buildHook('arbitrum', arbitrumOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'arbitrum',
        arbitrumOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        ROUTE_CHAINS,
      ),
      crossCollateralRouters,
    },
    arc: {
      type: TokenType.crossCollateral,
      token: usdcTokenAddresses.arc,
      mailbox: routerConfig.arc.mailbox,
      owner: arcOwner,
      ...cctpStandardRebalancingConfigByChain.arc,
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpStandardRebalancingConfigByChain.arc.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.arc?.allowedRebalancingBridges,
      ),
      hook: buildHook('arc', arcOwner),
      interchainSecurityModule: buildInterchainSecurityModule('arc', arcOwner),
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        ROUTE_CHAINS,
      ),
      crossCollateralRouters,
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDC,
      mailbox: routerConfig.base.mailbox,
      owner: baseOwner,
      ...cctpRebalancingConfigByChain.base,
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpRebalancingConfigByChain.base.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.base?.allowedRebalancingBridges,
        { citrea: [{ bridge: tbda.base }] },
        {
          arc: cctpStandardRebalancingConfigByChain.base
            .allowedRebalancingBridges.arc,
        },
      ),
      hook: buildHook('base', baseOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'base',
        baseOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        ROUTE_CHAINS,
      ),
      crossCollateralRouters,
    },
    bsc: {
      type: TokenType.crossCollateral,
      token: tokens.bsc.USDC,
      mailbox: routerConfig.bsc.mailbox,
      owner: bscOwner,
      ...additionalRebalancingConfigByChain.bsc,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
      hook: buildHook('bsc', bscOwner),
      interchainSecurityModule: buildInterchainSecurityModule('bsc', bscOwner),
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        ROUTE_CHAINS,
      ),
      crossCollateralRouters,
    },
    katana: {
      type: TokenType.crossCollateral,
      token: tokens.katana.USDC,
      mailbox: routerConfig.katana.mailbox,
      owner: katanaOwner,
      hook: buildHook('katana', katanaOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'katana',
        katanaOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        ROUTE_CHAINS,
      ),
      crossCollateralRouters,
    },
    citrea: {
      type: TokenType.crossCollateral,
      token: tokens.citrea.ctUSD,
      mailbox: routerConfig.citrea.mailbox,
      owner: citreaOwner,
      allowedRebalancers: [REBALANCER],
      allowedRebalancingBridges: Object.fromEntries(
        EVM_CHAINS.map((dest) => [dest, [{ bridge: tbda.citrea }]]),
      ),
      interchainSecurityModule: buildInterchainSecurityModule(
        'citrea',
        citreaOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        ROUTE_CHAINS.filter((c) => c !== 'citrea'),
      ),
      crossCollateralRouters,
    },
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDC,
      mailbox: routerConfig.ethereum.mailbox,
      owner: ethereumOwner,
      ...cctpRebalancingConfigByChain.ethereum,
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpRebalancingConfigByChain.ethereum.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.ethereum?.allowedRebalancingBridges,
        { citrea: [{ bridge: tbda.ethereum }] },
        {
          arc: cctpStandardRebalancingConfigByChain.ethereum
            .allowedRebalancingBridges.arc,
        },
      ),
      hook: buildHook('ethereum', ethereumOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'ethereum',
        ethereumOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        ROUTE_CHAINS,
      ),
      crossCollateralRouters,
    },
    polygon: {
      type: TokenType.crossCollateral,
      token: tokens.polygon.USDC,
      mailbox: routerConfig.polygon.mailbox,
      owner: polygonOwner,
      ...cctpRebalancingConfigByChain.polygon,
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpRebalancingConfigByChain.polygon.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.polygon?.allowedRebalancingBridges,
        { citrea: [{ bridge: tbda.polygon }] },
        {
          arc: cctpStandardRebalancingConfigByChain.polygon
            .allowedRebalancingBridges.arc,
        },
      ),
      hook: buildHook('polygon', polygonOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'polygon',
        polygonOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        ROUTE_CHAINS,
      ),
      crossCollateralRouters,
    },
  };
}

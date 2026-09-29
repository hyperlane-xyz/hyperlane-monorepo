import {
  ChainMap,
  ChainName,
  DEFAULT_ROUTER_KEY,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import fastpathIsms from '../../fastpath/isms.json' with { type: 'json' };
import { awIcas } from '../../governance/ica/aw.js';
import { warpFeesIcas } from '../../governance/ica/warpFees.js';
import { awSafes } from '../../governance/safe/aw.js';
import { warpFeesSafes } from '../../governance/safe/warpFees.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { usdcTokenAddresses } from '../cctp.js';
import { WarpRouteIds } from '../warpIds.js';
import {
  getCrossCollateralTargetRoutersByChain,
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

const ROUTE_CHAINS = [
  'solanamainnet',
  'arbitrum',
  'arc',
  'base',
  'bsc',
  'citrea',
  'ethereum',
  'katana',
  'polygon',
  'robinhood',
] as const satisfies readonly ChainName[];
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
const ROBINHOOD_USDG_TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
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
  robinhood: awIcas.robinhood,
} as const;

const feeOwnersByChain = {
  arbitrum: warpFeesIcas.arbitrum,
  arc: warpFeesIcas.arc,
  base: warpFeesIcas.base,
  bsc: warpFeesIcas.bsc,
  citrea: warpFeesIcas.citrea,
  ethereum: warpFeesSafes.ethereum,
  katana: warpFeesIcas.katana,
  polygon: warpFeesIcas.polygon,
  robinhood: warpFeesIcas.robinhood,
} as const;
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

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
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDTCitreaMoonpay);
  assert(route, 'USDT/moonpay route not found in registry');
  return Object.fromEntries(
    route.tokens.map(({ chainName, addressOrDenom }) => {
      assert(addressOrDenom, `Missing USDT router for ${chainName}`);
      return [
        String(getDomainId(chainName)),
        [addressToBytes32(addressOrDenom)],
      ];
    }),
  );
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

// Target routers (destination tokens) priced per destination, keyed by chain.
// Union of both Moonpay routes so USDC/USDT/ctUSD/XO can each be priced distinctly.
const TARGET_ROUTERS_BY_CHAIN = getCrossCollateralTargetRoutersByChain([
  WarpRouteIds.USDCCitreaMoonpay,
  WarpRouteIds.USDTCitreaMoonpay,
]);

function buildCrossCollateralRoutingFee(
  owner: string,
  destinations: readonly ChainName[],
): TokenFeeConfigInput {
  const offchainFee = (): TokenFeeConfigInput => ({
    type: TokenFeeType.OffchainQuotedLinearFee,
    owner,
    bps: 3,
    quoteSigners: QUOTE_SIGNERS,
  });

  return {
    type: TokenFeeType.CrossCollateralRoutingFee,
    owner,
    feeContracts: Object.fromEntries(
      destinations.map((dest) => {
        const targetRouters = TARGET_ROUTERS_BY_CHAIN[dest] ?? [];
        return [
          dest,
          {
            // Per-destination-token fee slots, plus a default fallback.
            ...Object.fromEntries(
              targetRouters.map((routerKey) => [routerKey, offchainFee()]),
            ),
            [DEFAULT_ROUTER_KEY]: offchainFee(),
          },
        ];
      }),
    ),
  };
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
    ['arbitrum', 'base', 'bsc', 'ethereum', 'polygon'],
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
    robinhood: robinhoodOwner,
  } = ownersByChain;
  const {
    arbitrum: arbitrumFeeOwner,
    arc: arcFeeOwner,
    base: baseFeeOwner,
    bsc: bscFeeOwner,
    citrea: citreaFeeOwner,
    ethereum: ethereumFeeOwner,
    katana: katanaFeeOwner,
    polygon: polygonFeeOwner,
    robinhood: robinhoodFeeOwner,
  } = feeOwnersByChain;

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
      tokenFee: buildCrossCollateralRoutingFee(arbitrumFeeOwner, ROUTE_CHAINS),
      crossCollateralRouters,
    },
    arc: {
      type: TokenType.crossCollateral,
      token: usdcTokenAddresses.arc,
      mailbox: routerConfig.arc.mailbox,
      owner: arcOwner,
      ...cctpStandardRebalancingConfigByChain.arc,
      hook: buildHook('arc', arcOwner),
      interchainSecurityModule: buildInterchainSecurityModule('arc', arcOwner),
      tokenFee: buildCrossCollateralRoutingFee(arcFeeOwner, ROUTE_CHAINS),
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
      tokenFee: buildCrossCollateralRoutingFee(baseFeeOwner, ROUTE_CHAINS),
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
      tokenFee: buildCrossCollateralRoutingFee(bscFeeOwner, ROUTE_CHAINS),
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
      tokenFee: buildCrossCollateralRoutingFee(katanaFeeOwner, ROUTE_CHAINS),
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
        citreaFeeOwner,
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
      tokenFee: buildCrossCollateralRoutingFee(ethereumFeeOwner, ROUTE_CHAINS),
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
      tokenFee: buildCrossCollateralRoutingFee(polygonFeeOwner, ROUTE_CHAINS),
      crossCollateralRouters,
    },
    robinhood: {
      type: TokenType.crossCollateral,
      token: ROBINHOOD_USDG_TOKEN,
      mailbox: routerConfig.robinhood.mailbox,
      owner: robinhoodOwner,
      interchainSecurityModule: buildInterchainSecurityModule(
        'robinhood',
        robinhoodOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(robinhoodFeeOwner, ROUTE_CHAINS),
      crossCollateralRouters,
    },
  };
}

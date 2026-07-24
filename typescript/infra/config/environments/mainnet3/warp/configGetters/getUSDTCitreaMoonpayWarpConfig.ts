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
import { WarpRouteIds } from '../warpIds.js';
import {
  getCrossCollateralTargetRoutersByChain,
  getRebalancingBridgesConfigFor,
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

const ownersByChain = {
  arbitrum: awIcas.arbitrum,
  base: awIcas.base,
  bsc: awIcas.bsc,
  ethereum: awSafes.ethereum,
  katana: awIcas.katana,
  polygon: awIcas.polygon,
} as const;

const feeOwnersByChain = {
  arbitrum: warpFeesIcas.arbitrum,
  base: warpFeesIcas.base,
  bsc: warpFeesIcas.bsc,
  ethereum: warpFeesSafes.ethereum,
  katana: warpFeesIcas.katana,
  polygon: warpFeesIcas.polygon,
} as const;
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

const ROUTE_CHAINS = [
  'solanamainnet',
  'arbitrum',
  'base',
  'bsc',
  'citrea',
  'ethereum',
  'katana',
  'polygon',
] as const satisfies readonly ChainName[];

const EVM_CHAINS = ['arbitrum', 'base', 'ethereum', 'polygon'] as const;
type EvmChain = (typeof EVM_CHAINS)[number];

const CCTP_CHAINS = EVM_CHAINS;

function getCctpFastRouteAddresses(): Record<EvmChain, string> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.MainnetCCTPV2Fast);
  assert(route, 'Mainnet CCTP v2 fast route not found in registry');

  return Object.fromEntries(
    CCTP_CHAINS.map((chain) => {
      const token = route.tokens.find(({ chainName }) => chainName === chain);
      assert(token?.addressOrDenom, `Missing fast route address for ${chain}`);
      return [chain, token.addressOrDenom];
    }),
  ) as Record<EvmChain, string>;
}

const CCTP_FAST_ROUTE_ADDRESSES = getCctpFastRouteAddresses();

function getUsdcCrossCollateralRouters(): Record<string, string[]> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDCCitreaMoonpay);
  assert(route, 'USDC/moonpay route not found in registry');
  return Object.fromEntries(
    route.tokens.map(({ chainName, addressOrDenom }) => {
      assert(addressOrDenom, `Missing USDC router for ${chainName}`);
      return [
        String(getDomainId(chainName)),
        [addressToBytes32(addressOrDenom)],
      ];
    }),
  );
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

function buildDefaultIsm(owner: string): IsmConfig {
  return {
    type: IsmType.FALLBACK_ROUTING,
    domains: {},
    owner,
  };
}

function isCctpChain(chain: ChainName): chain is EvmChain {
  return CCTP_CHAINS.includes(chain as EvmChain);
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
): IsmConfig {
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

function buildHook(local: ChainName, owner: string) {
  const fastAddress = (CCTP_FAST_ROUTE_ADDRESSES as Record<string, string>)[
    local
  ];
  return {
    type: HookType.FALLBACK_ROUTING,
    owner,
    domains: fastAddress
      ? Object.fromEntries(
          CCTP_CHAINS.filter((remote) => remote !== local).map((remote) => [
            remote,
            {
              type: HookType.AGGREGATION,
              hooks: [{ type: HookType.MAILBOX_DEFAULT }, fastAddress],
            } as const satisfies HookConfig,
          ]),
        )
      : {},
    fallback: { type: HookType.MAILBOX_DEFAULT },
  } as const;
}

export async function getUSDTCitreaMoonpayWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<{ owner: string }>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const oftRebalancingConfigByChain = getRebalancingBridgesConfigFor(
    [...EVM_CHAINS, 'bsc'],
    [WarpRouteIds.USDTOft, WarpRouteIds.EclipseUSDT],
  );

  const {
    arbitrum: arbitrumOwner,
    base: baseOwner,
    bsc: bscOwner,
    ethereum: ethereumOwner,
    katana: katanaOwner,
    polygon: polygonOwner,
  } = ownersByChain;
  const {
    arbitrum: arbitrumFeeOwner,
    base: baseFeeOwner,
    bsc: bscFeeOwner,
    ethereum: ethereumFeeOwner,
    katana: katanaFeeOwner,
    polygon: polygonFeeOwner,
  } = feeOwnersByChain;

  const crossCollateralRouters = getUsdcCrossCollateralRouters();

  assert(oftRebalancingConfigByChain.bsc, 'missing rebalancing config for bsc');

  return {
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDT,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: arbitrumOwner,
      ...oftRebalancingConfigByChain.arbitrum,
      hook: buildHook('arbitrum', arbitrumOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'arbitrum',
        arbitrumOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(arbitrumFeeOwner, ROUTE_CHAINS),
      crossCollateralRouters,
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDT,
      mailbox: routerConfig.base.mailbox,
      owner: baseOwner,
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
      token: tokens.bsc.USDT,
      mailbox: routerConfig.bsc.mailbox,
      owner: bscOwner,
      ...oftRebalancingConfigByChain.bsc,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
      hook: buildHook('bsc', bscOwner),
      interchainSecurityModule: buildInterchainSecurityModule('bsc', bscOwner),
      tokenFee: buildCrossCollateralRoutingFee(bscFeeOwner, ROUTE_CHAINS),
      crossCollateralRouters,
    },
    katana: {
      type: TokenType.crossCollateral,
      token: tokens.katana.USDT,
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
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDT,
      mailbox: routerConfig.ethereum.mailbox,
      owner: ethereumOwner,
      ...oftRebalancingConfigByChain.ethereum,
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
      token: tokens.polygon.USDT,
      mailbox: routerConfig.polygon.mailbox,
      owner: polygonOwner,
      ...oftRebalancingConfigByChain.polygon,
      hook: buildHook('polygon', polygonOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'polygon',
        polygonOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(polygonFeeOwner, ROUTE_CHAINS),
      crossCollateralRouters,
    },
  };
}

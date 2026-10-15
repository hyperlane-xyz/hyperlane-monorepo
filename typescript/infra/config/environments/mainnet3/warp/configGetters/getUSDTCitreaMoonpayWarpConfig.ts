import {
  ChainMap,
  ChainName,
  CrossCollateralTokenConfig,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import fastpathIsms from '../../fastpath/isms.json' with { type: 'json' };
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { WARP_FEES_TURNKEY_OWNER } from '../../governance/utils.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';
import {
  buildCrossCollateralRoutingFee,
  getMoonpayCrossCollateralRouters,
  MOONPAY_ROUTE_CHAINS,
} from './moonpay.js';
import {
  getRebalancingBridgesConfigFor,
  REBALANCER,
  type RebalancingConfig,
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

const AUDITED_CONTRACT_VERSION = '12.0.0';

const LOCAL_REBALANCE_CHAINS = [
  'arbitrum',
  'base',
  'bsc',
  'ethereum',
  'polygon',
] as const;

type CrossCollateralLocalRebalancingConfig = Required<
  Pick<
    CrossCollateralTokenConfig,
    | 'allowedRebalancingBridges'
    | 'allowedRebalancers'
    | 'contractVersion'
    | 'rebalanceRecipients'
    | 'rebalanceTargets'
  >
>;

const ROUTE_CHAINS = MOONPAY_ROUTE_CHAINS;

const EVM_CHAINS = ['arbitrum', 'base', 'ethereum', 'polygon'] as const;

const CCTP_CHAINS = [...EVM_CHAINS, 'arc'] as const;

function getCctpFastRouteAddresses(): ChainMap<string> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.MainnetCCTPV2Fast);
  assert(route, 'Mainnet CCTP v2 fast route not found in registry');

  return Object.fromEntries(
    CCTP_CHAINS.map((chain) => {
      const token = route.tokens.find(({ chainName }) => chainName === chain);
      assert(token?.addressOrDenom, `Missing fast route address for ${chain}`);
      return [chain, token.addressOrDenom];
    }),
  );
}

const CCTP_FAST_ROUTE_ADDRESSES = getCctpFastRouteAddresses();

function getUsdcCrossCollateralRouters(): Record<string, string[]> {
  return getMoonpayCrossCollateralRouters([WarpRouteIds.USDCCitreaMoonpay]);
}

function getAtomicLocalRebalancingConfig(
  existingByChain: ChainMap<RebalancingConfig>,
): ChainMap<CrossCollateralLocalRebalancingConfig> {
  const registry = getRegistry();
  const localBridgeRoute = registry.getWarpRoute(
    WarpRouteIds.CROSSMoonpayLocalBridgeUSDT,
  );
  assert(localBridgeRoute, 'Moonpay local USDT bridge route not found');

  const usdcRoute = registry.getWarpRoute(WarpRouteIds.USDCCitreaMoonpay);
  assert(usdcRoute, 'USDC/moonpay route not found in registry');

  return Object.fromEntries(
    LOCAL_REBALANCE_CHAINS.map((chain) => {
      const bridge = localBridgeRoute.tokens.find(
        ({ chainName }) => chainName === chain,
      )?.addressOrDenom;
      assert(bridge, `Missing Moonpay local USDT bridge on ${chain}`);

      const destinationRouter = usdcRoute.tokens.find(
        ({ chainName }) => chainName === chain,
      )?.addressOrDenom;
      assert(destinationRouter, `Missing Moonpay USDC router on ${chain}`);

      const destination = addressToBytes32(destinationRouter);
      const existing = existingByChain[chain];

      return [
        chain,
        {
          contractVersion: AUDITED_CONTRACT_VERSION,
          allowedRebalancers: [
            ...new Set([
              ...(existing?.allowedRebalancers ?? []),
              REBALANCER,
              bridge,
            ]),
          ],
          allowedRebalancingBridges: {
            ...existing?.allowedRebalancingBridges,
            [chain]: [{ bridge }],
          },
          rebalanceTargets: { [chain]: [destination] },
          rebalanceRecipients: { [chain]: destination },
        },
      ];
    }),
  );
}

function buildDefaultIsm(owner: string): IsmConfig {
  return {
    type: IsmType.FALLBACK_ROUTING,
    domains: {},
    owner,
  };
}

function isCctpChain(chain: ChainName): chain is (typeof CCTP_CHAINS)[number] {
  return CCTP_CHAINS.some((candidate) => candidate === chain);
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
  const fastAddress = isCctpChain(local)
    ? CCTP_FAST_ROUTE_ADDRESSES[local]
    : undefined;
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
  const rebalancingConfigByChain = getAtomicLocalRebalancingConfig(
    oftRebalancingConfigByChain,
  );

  const {
    arbitrum: arbitrumOwner,
    base: baseOwner,
    bsc: bscOwner,
    ethereum: ethereumOwner,
    katana: katanaOwner,
    polygon: polygonOwner,
  } = ownersByChain;
  const crossCollateralRouters = getUsdcCrossCollateralRouters();

  assert(oftRebalancingConfigByChain.bsc, 'missing rebalancing config for bsc');

  return {
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDT,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: arbitrumOwner,
      ...rebalancingConfigByChain.arbitrum,
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
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDT,
      mailbox: routerConfig.base.mailbox,
      owner: baseOwner,
      ...rebalancingConfigByChain.base,
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
      token: tokens.bsc.USDT,
      mailbox: routerConfig.bsc.mailbox,
      owner: bscOwner,
      ...rebalancingConfigByChain.bsc,
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
      token: tokens.katana.USDT,
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
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDT,
      mailbox: routerConfig.ethereum.mailbox,
      owner: ethereumOwner,
      ...rebalancingConfigByChain.ethereum,
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
      token: tokens.polygon.USDT,
      mailbox: routerConfig.polygon.mailbox,
      owner: polygonOwner,
      ...rebalancingConfigByChain.polygon,
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

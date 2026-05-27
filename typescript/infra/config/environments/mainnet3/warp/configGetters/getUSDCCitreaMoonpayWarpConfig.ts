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

import relayerAddresses from '../../../../relayer.json' with { type: 'json' };
import { awIcas } from '../../governance/ica/aw.js';
import { warpFeesIcas } from '../../governance/ica/warpFees.js';
import { awSafes } from '../../governance/safe/aw.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';
import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const FAST_PATH_RELAYER = relayerAddresses.mainnet3.fastpath;

const ROUTE_CHAINS = [
  'solanamainnet',
  'arbitrum',
  'base',
  'citrea',
  'ethereum',
  'polygon',
] as const satisfies readonly ChainName[];
const CCTP_CHAINS = [
  'arbitrum',
  'base',
  'ethereum',
  'polygon',
] as const satisfies readonly ChainName[];
const EVM_CHAINS = ['arbitrum', 'base', 'ethereum', 'polygon'] as const;
type EvmChain = (typeof EVM_CHAINS)[number];

const SOLANA_IGP_ADDRESS = 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv';
const SOLANA_XO_TOKEN_MINT = 'xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y';
const SOLANA_XO_NAME = 'XO Cash';
const SOLANA_XO_SYMBOL = 'XO';
const ownersByChain = {
  solanamainnet: 'BNGDJ1h9brgt6FFVd8No1TVAH48Fp44d7jkuydr1URwJ', // Squads multisig
  arbitrum: awIcas.arbitrum,
  base: awIcas.base,
  citrea: awIcas.citrea,
  ethereum: awSafes.ethereum,
  polygon: awIcas.polygon,
} as const;

const feeOwnersByChain = {
  arbitrum: warpFeesIcas.arbitrum,
  base: warpFeesIcas.base,
  citrea: warpFeesIcas.citrea,
  ethereum: warpFeesIcas.ethereum,
  polygon: warpFeesIcas.polygon,
} as const;
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';
const AMOUNT_ROUTING_THRESHOLD = 1_000_000_000;

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

function isCctpChain(chain: ChainName): chain is EvmChain {
  return CCTP_CHAINS.includes(chain as EvmChain);
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

  if (local === 'citrea' && remote === 'ethereum') {
    return { type: IsmType.TRUSTED_RELAYER, relayer: FAST_PATH_RELAYER };
  }

  return buildDefaultIsm(owner);
}

function shouldIncludeInnerRoutingRemote(
  local: (typeof ROUTE_CHAINS)[number],
  remote: (typeof ROUTE_CHAINS)[number],
): boolean {
  return (
    (isCctpChain(local) && isCctpChain(remote)) ||
    (local === 'citrea' && remote === 'ethereum')
  );
}

function buildInnerRoutingIsm(
  local: (typeof ROUTE_CHAINS)[number],
  owner: string,
): IsmConfig {
  const domains = Object.fromEntries(
    ROUTE_CHAINS.filter(
      (remote) =>
        remote !== local && shouldIncludeInnerRoutingRemote(local, remote),
    ).map((remote) => [remote, buildRemoteIsm(local, remote, owner)]),
  );

  return {
    type: IsmType.ROUTING,
    owner,
    domains,
  } as const;
}

function buildInterchainSecurityModule(
  local: (typeof ROUTE_CHAINS)[number],
  owner: string,
): IsmConfig | undefined {
  if (local === 'solanamainnet') return undefined;

  if (local === 'citrea') {
    // Amount routing: small txs use trusted relayer for fast finality, large use default
    return {
      type: IsmType.AGGREGATION,
      threshold: 1,
      modules: [
        buildDefaultIsm(owner),
        {
          type: IsmType.AMOUNT_ROUTING,
          threshold: AMOUNT_ROUTING_THRESHOLD,
          lowerIsm: buildInnerRoutingIsm(local, owner),
          upperIsm: buildDefaultIsm(owner),
        },
      ],
    } as const;
  }

  // CCTP chains: route directly via CCTP fast ISM, no amount routing needed
  return {
    type: IsmType.AGGREGATION,
    threshold: 1,
    modules: [buildInnerRoutingIsm(local, owner), buildDefaultIsm(owner)],
  } as const;
}

function buildFastRouteHook(local: EvmChain, owner: string) {
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

function buildCrossCollateralRoutingFee(
  owner: string,
  destinations: readonly ChainName[],
): TokenFeeConfigInput {
  return {
    type: TokenFeeType.CrossCollateralRoutingFee,
    owner,
    feeContracts: Object.fromEntries(
      destinations.map((dest) => [
        dest,
        {
          [DEFAULT_ROUTER_KEY]: {
            type: TokenFeeType.OffchainQuotedLinearFee,
            owner,
            bps: 3,
            quoteSigners: QUOTE_SIGNERS,
          },
        },
      ]),
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

  const tbda = getTBDAAddresses();

  const {
    solanamainnet: solanaOwner,
    arbitrum: arbitrumOwner,
    base: baseOwner,
    citrea: citreaOwner,
    ethereum: ethereumOwner,
    polygon: polygonOwner,
  } = ownersByChain;
  const {
    arbitrum: arbitrumFeeOwner,
    base: baseFeeOwner,
    citrea: citreaFeeOwner,
    ethereum: ethereumFeeOwner,
    polygon: polygonFeeOwner,
  } = feeOwnersByChain;

  const crossCollateralRouters = getUsdtCrossCollateralRouters();

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
      allowedRebalancingBridges: {
        ...cctpRebalancingConfigByChain.arbitrum.allowedRebalancingBridges,
        [String(getDomainId('citrea'))]: [{ bridge: tbda.arbitrum }],
      },
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
      token: tokens.base.USDC,
      mailbox: routerConfig.base.mailbox,
      owner: baseOwner,
      ...cctpRebalancingConfigByChain.base,
      allowedRebalancingBridges: {
        ...cctpRebalancingConfigByChain.base.allowedRebalancingBridges,
        [String(getDomainId('citrea'))]: [{ bridge: tbda.base }],
      },
      hook: buildHook('base', baseOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'base',
        baseOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(baseFeeOwner, ROUTE_CHAINS),
      crossCollateralRouters,
    },
    citrea: {
      type: TokenType.crossCollateral,
      token: tokens.citrea.ctUSD,
      mailbox: routerConfig.citrea.mailbox,
      owner: citreaOwner,
      allowedRebalancers: [REBALANCER],
      allowedRebalancingBridges: Object.fromEntries(
        EVM_CHAINS.map((dest) => [
          String(getDomainId(dest)),
          [{ bridge: tbda.citrea }],
        ]),
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
      allowedRebalancingBridges: {
        ...cctpRebalancingConfigByChain.ethereum.allowedRebalancingBridges,
        [String(getDomainId('citrea'))]: [{ bridge: tbda.ethereum }],
      },
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
      allowedRebalancingBridges: {
        ...cctpRebalancingConfigByChain.polygon.allowedRebalancingBridges,
        [String(getDomainId('citrea'))]: [{ bridge: tbda.polygon }],
      },
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

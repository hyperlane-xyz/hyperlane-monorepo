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

import { awIcas } from '../../governance/ica/aw.js';
import { warpFeesIcas } from '../../governance/ica/warpFees.js';
import { awSafes } from '../../governance/safe/aw.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';
import { getRebalancingBridgesConfigFor } from './utils.js';

const ownersByChain = {
  arbitrum: awIcas.arbitrum,
  base: awIcas.base,
  ethereum: awSafes.ethereum,
} as const;

const feeOwnersByChain = {
  arbitrum: warpFeesIcas.arbitrum,
  base: warpFeesIcas.base,
  ethereum: warpFeesIcas.ethereum,
} as const;
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

const ROUTE_CHAINS = [
  'solanamainnet',
  'arbitrum',
  'base',
  'citrea',
  'ethereum',
] as const satisfies readonly ChainName[];

const EVM_CHAINS = ['arbitrum', 'base', 'ethereum'] as const;
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

function buildDefaultIsm(owner: string): IsmConfig {
  return {
    type: IsmType.FALLBACK_ROUTING,
    domains: {},
    owner,
  };
}

function buildInnerRoutingIsm(local: EvmChain, owner: string): IsmConfig {
  const domains = Object.fromEntries(
    CCTP_CHAINS.filter((remote) => remote !== local).map((remote) => [
      remote,
      CCTP_FAST_ROUTE_ADDRESSES[local] as IsmConfig,
    ]),
  );

  return {
    type: IsmType.ROUTING,
    owner,
    domains,
  } as const;
}

function buildInterchainSecurityModule(
  local: EvmChain,
  owner: string,
): IsmConfig {
  return {
    type: IsmType.AGGREGATION,
    threshold: 1,
    modules: [buildInnerRoutingIsm(local, owner), buildDefaultIsm(owner)],
  } as const;
}

function buildHook(local: EvmChain, owner: string) {
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

export async function getUSDTCitreaMoonpayWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<{ owner: string }>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const oftRebalancingConfigByChain = getRebalancingBridgesConfigFor(
    EVM_CHAINS,
    [WarpRouteIds.USDTOft],
  );

  const {
    arbitrum: arbitrumOwner,
    base: baseOwner,
    ethereum: ethereumOwner,
  } = ownersByChain;
  const {
    arbitrum: arbitrumFeeOwner,
    base: baseFeeOwner,
    ethereum: ethereumFeeOwner,
  } = feeOwnersByChain;

  const crossCollateralRouters = getUsdcCrossCollateralRouters();

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
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDT,
      mailbox: routerConfig.ethereum.mailbox,
      owner: ethereumOwner,
      ...oftRebalancingConfigByChain.ethereum,
      remoteRouters: {
        8453: { address: '0x7abBb4ea8a5895127500CF0C15830C9Eb9f61F96' },
        42161: { address: '0x75a9297db5F0349fd1d6f4030953Fe17175e06d4' },
      },
      hook: buildHook('ethereum', ethereumOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'ethereum',
        ethereumOwner,
      ),
      tokenFee: buildCrossCollateralRoutingFee(ethereumFeeOwner, ROUTE_CHAINS),
      crossCollateralRouters,
    },
  };
}

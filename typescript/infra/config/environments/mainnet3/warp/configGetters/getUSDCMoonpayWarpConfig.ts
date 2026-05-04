import {
  ChainMap,
  ChainName,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import relayerAddresses from '../../../../relayer.json' with { type: 'json' };
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';
import { getFixedRoutingFeeConfig } from './utils.js';

const FAST_PATH_RELAYER = relayerAddresses.mainnet3.fastpath;

const ROUTE_CHAINS = [
  'solanamainnet',
  'arbitrum',
  'base',
  'citrea',
  'ethereum',
] as const satisfies readonly ChainName[];
const CCTP_CHAINS = [
  'arbitrum',
  'base',
  'ethereum',
] as const satisfies readonly ChainName[];
const AMOUNT_ROUTING_THRESHOLD = 100_000 * 10 ** 6;

const SOLANA_IGP_ADDRESS = 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv';
const SOLANA_XO_TOKEN_MINT = 'xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y';
const SOLANA_XO_NAME = 'XO Cash';
const SOLANA_XO_SYMBOL = 'XO';
const MOONPAY_OWNER = '0xEA2117b24F7947647Bec60527B68f4244AE40c01';
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

function trustedRelayerIsm(relayer: string) {
  return {
    type: IsmType.TRUSTED_RELAYER,
    relayer,
  } as const;
}

function getCctpFastRouteAddresses(): Record<
  (typeof CCTP_CHAINS)[number],
  string
> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.MainnetCCTPV2Fast);
  assert(route, 'Mainnet CCTP v2 fast route not found in registry');

  return Object.fromEntries(
    CCTP_CHAINS.map((chain) => {
      const token = route.tokens.find(({ chainName }) => chainName === chain);
      assert(token?.addressOrDenom, `Missing fast route address for ${chain}`);
      return [chain, token.addressOrDenom];
    }),
  ) as Record<(typeof CCTP_CHAINS)[number], string>;
}

const CCTP_FAST_ROUTE_ADDRESSES = getCctpFastRouteAddresses();

function isCctpChain(chain: ChainName): chain is (typeof CCTP_CHAINS)[number] {
  return CCTP_CHAINS.includes(chain as (typeof CCTP_CHAINS)[number]);
}

function getTrustedRelayer(local: ChainName, remote: ChainName): string {
  return FAST_PATH_RELAYER;
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
    return {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [
        trustedRelayerIsm(getTrustedRelayer(local, remote)),
        CCTP_FAST_ROUTE_ADDRESSES[local],
      ],
    };
  }

  if (local === 'citrea' && remote === 'ethereum') {
    return {
      type: IsmType.AGGREGATION,
      threshold: 1,
      modules: [
        trustedRelayerIsm(getTrustedRelayer(local, remote)),
        buildDefaultIsm(owner),
      ],
    };
  }

  return buildDefaultIsm(owner);
}

function buildInnerRoutingIsm(
  local: (typeof ROUTE_CHAINS)[number],
  owner: string,
): IsmConfig {
  const domains = Object.fromEntries(
    ROUTE_CHAINS.filter((remote) => remote !== local).map((remote) => [
      remote,
      buildRemoteIsm(local, remote, owner),
    ]),
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
  const amountRoutingIsm = {
    type: IsmType.AMOUNT_ROUTING,
    threshold: AMOUNT_ROUTING_THRESHOLD,
    lowerIsm: buildInnerRoutingIsm(local, owner),
    upperIsm: buildDefaultIsm(owner),
  } as const;

  return {
    type: IsmType.AGGREGATION,
    threshold: 1,
    modules: [buildDefaultIsm(owner), amountRoutingIsm],
  } as const;
}

function buildFastRouteHook(
  local: (typeof CCTP_CHAINS)[number],
  owner: string,
) {
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

  return {
    type: HookType.AMOUNT_ROUTING,
    threshold: AMOUNT_ROUTING_THRESHOLD,
    lowerHook: buildFastRouteHook(local, owner),
    upperHook: { type: HookType.MAILBOX_DEFAULT },
  } as const satisfies HookConfig;
}

export async function getUSDCMoonpayWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const feeDestinationsByChain = Object.fromEntries(
    ROUTE_CHAINS.map((local) => [
      local,
      ROUTE_CHAINS.filter((remote) => remote !== local),
    ]),
  ) as Record<(typeof ROUTE_CHAINS)[number], ChainName[]>;

  const solanamainnetOwner = _abacusWorksEnvOwnerConfig.solanamainnet.owner;
  const arbitrumOwner = MOONPAY_OWNER;
  const baseOwner = MOONPAY_OWNER;
  const citreaOwner = MOONPAY_OWNER;
  const ethereumOwner = MOONPAY_OWNER;

  return {
    solanamainnet: {
      type: TokenType.crossCollateral,
      token: SOLANA_XO_TOKEN_MINT,
      mailbox: routerConfig.solanamainnet.mailbox,
      owner: solanamainnetOwner,
      hook: buildHook('solanamainnet', solanamainnetOwner),
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      name: SOLANA_XO_NAME,
      symbol: SOLANA_XO_SYMBOL,
      decimals: 6,
    },
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDC,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: arbitrumOwner,
      hook: buildHook('arbitrum', arbitrumOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'arbitrum',
        arbitrumOwner,
      ),
      tokenFee: getFixedRoutingFeeConfig(
        MOONPAY_OWNER,
        feeDestinationsByChain.arbitrum,
        3,
        undefined,
        QUOTE_SIGNERS,
      ),
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDC,
      mailbox: routerConfig.base.mailbox,
      owner: baseOwner,
      hook: buildHook('base', baseOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'base',
        baseOwner,
      ),
      tokenFee: getFixedRoutingFeeConfig(
        MOONPAY_OWNER,
        feeDestinationsByChain.base,
        3,
        undefined,
        QUOTE_SIGNERS,
      ),
    },
    citrea: {
      type: TokenType.crossCollateral,
      token: tokens.citrea.ctUSD,
      mailbox: routerConfig.citrea.mailbox,
      owner: citreaOwner,
      interchainSecurityModule: buildInterchainSecurityModule(
        'citrea',
        citreaOwner,
      ),
      tokenFee: getFixedRoutingFeeConfig(
        MOONPAY_OWNER,
        feeDestinationsByChain.citrea,
        3,
        undefined,
        QUOTE_SIGNERS,
      ),
    },
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDC,
      mailbox: routerConfig.ethereum.mailbox,
      owner: ethereumOwner,
      hook: buildHook('ethereum', ethereumOwner),
      interchainSecurityModule: buildInterchainSecurityModule(
        'ethereum',
        ethereumOwner,
      ),
      tokenFee: getFixedRoutingFeeConfig(
        MOONPAY_OWNER,
        feeDestinationsByChain.ethereum,
        3,
        undefined,
        QUOTE_SIGNERS,
      ),
    },
  };
}

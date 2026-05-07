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
import {
  getFixedRoutingFeeConfig,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

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
const EVM_CHAINS = ['arbitrum', 'base', 'ethereum'] as const;
type EvmChain = (typeof EVM_CHAINS)[number];

const SOLANA_IGP_ADDRESS = 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv';
const SOLANA_XO_TOKEN_MINT = 'xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y';
const SOLANA_XO_NAME = 'XO Cash';
const SOLANA_XO_SYMBOL = 'XO';
const SOLANA_MOONPAY_OWNER = 'BNGDJ1h9brgt6FFVd8No1TVAH48Fp44d7jkuydr1URwJ';
const MOONPAY_OWNER = '0xEA2117b24F7947647Bec60527B68f4244AE40c01';
const NO_OWNER = '0x0000000000000000000000000000000000000000';
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

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

function getTBDAAddresses(): Record<EvmChain | 'citrea', string> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDCCitreaIronBridge);
  assert(route, 'CROSS/ctusd-ironbridge route not found in registry');

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
  };
}

const CCTP_FAST_ROUTE_ADDRESSES = getCctpFastRouteAddresses();

function isCctpChain(chain: ChainName): chain is EvmChain {
  return CCTP_CHAINS.includes(chain as EvmChain);
}

function buildDefaultIsm(): IsmConfig {
  return {
    type: IsmType.FALLBACK_ROUTING,
    domains: {},
    owner: NO_OWNER,
  };
}

function buildRemoteIsm(
  local: (typeof ROUTE_CHAINS)[number],
  remote: (typeof ROUTE_CHAINS)[number],
): IsmConfig {
  if (isCctpChain(local) && isCctpChain(remote)) {
    return CCTP_FAST_ROUTE_ADDRESSES[local];
  }

  if (local === 'citrea' && remote === 'ethereum') {
    return { type: IsmType.TRUSTED_RELAYER, relayer: FAST_PATH_RELAYER };
  }

  return buildDefaultIsm();
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
    ).map((remote) => [remote, buildRemoteIsm(local, remote)]),
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
  return {
    type: IsmType.AGGREGATION,
    threshold: 1,
    modules: [buildDefaultIsm(), buildInnerRoutingIsm(local, owner)],
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

export async function getUSDCCitreaMoonpayWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const cctpRebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    ['arbitrum', 'base', 'ethereum'],
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const tbda = getTBDAAddresses();

  const feeDestinationsByChain = Object.fromEntries(
    ROUTE_CHAINS.map((local) => [
      local,
      ROUTE_CHAINS.filter((remote) => remote !== local),
    ]),
  ) as Record<(typeof ROUTE_CHAINS)[number], ChainName[]>;

  return {
    solanamainnet: {
      type: TokenType.crossCollateral,
      token: SOLANA_XO_TOKEN_MINT,
      mailbox: routerConfig.solanamainnet.mailbox,
      owner: SOLANA_MOONPAY_OWNER,
      hook: buildHook('solanamainnet', SOLANA_MOONPAY_OWNER),
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      name: SOLANA_XO_NAME,
      symbol: SOLANA_XO_SYMBOL,
      decimals: 6,
    },
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDC,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: MOONPAY_OWNER,
      ...cctpRebalancingConfigByChain.arbitrum,
      allowedRebalancingBridges: {
        ...cctpRebalancingConfigByChain.arbitrum.allowedRebalancingBridges,
        citrea: [
          { bridge: tbda.arbitrum, approvedTokens: [tokens.arbitrum.USDC] },
        ],
      },
      hook: buildHook('arbitrum', MOONPAY_OWNER),
      interchainSecurityModule: buildInterchainSecurityModule(
        'arbitrum',
        MOONPAY_OWNER,
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
      owner: MOONPAY_OWNER,
      ...cctpRebalancingConfigByChain.base,
      allowedRebalancingBridges: {
        ...cctpRebalancingConfigByChain.base.allowedRebalancingBridges,
        citrea: [{ bridge: tbda.base, approvedTokens: [tokens.base.USDC] }],
      },
      hook: buildHook('base', MOONPAY_OWNER),
      interchainSecurityModule: buildInterchainSecurityModule(
        'base',
        MOONPAY_OWNER,
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
      owner: MOONPAY_OWNER,
      allowedRebalancers: [REBALANCER],
      allowedRebalancingBridges: Object.fromEntries(
        EVM_CHAINS.map((dest) => [
          dest,
          [{ bridge: tbda.citrea, approvedTokens: [tokens.citrea.ctUSD] }],
        ]),
      ),
      interchainSecurityModule: buildInterchainSecurityModule(
        'citrea',
        MOONPAY_OWNER,
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
      owner: MOONPAY_OWNER,
      ...cctpRebalancingConfigByChain.ethereum,
      allowedRebalancingBridges: {
        ...cctpRebalancingConfigByChain.ethereum.allowedRebalancingBridges,
        citrea: [
          { bridge: tbda.ethereum, approvedTokens: [tokens.ethereum.USDC] },
        ],
      },
      hook: buildHook('ethereum', MOONPAY_OWNER),
      interchainSecurityModule: buildInterchainSecurityModule(
        'ethereum',
        MOONPAY_OWNER,
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

import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  HypTokenRouterConfig,
  IsmType,
  OwnableConfig,
  RoutingIsmConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import relayerAddresses from '../../../../relayer.json' with { type: 'json' };
import { DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS } from '../../../utils.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getExistingWarpDeployConfig } from './utils.js';

const STAGING_SOURCE_WARP_ROUTE_ID = 'USDC/ctusd';
const FAST_PATH_RELAYER = relayerAddresses.mainnet3.fastpath;
const HYPERLANE_RELAYER = relayerAddresses.mainnet3.hyperlane;
const CCTP_CAPABLE_CHAINS: ChainName[] = ['arbitrum', 'base', 'ethereum'];
const ROUTE_CHAINS: ChainName[] = [
  'solanamainnet',
  'arbitrum',
  'base',
  'citrea',
  'ethereum',
  'katana',
];
const SOLANA_XO_TOKEN_MINT = 'xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y';
const SOLANA_XO_NAME = 'XO Cash';
const SOLANA_XO_SYMBOL = 'XO';
const KATANA_VBUSDC_TOKEN = '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36';

function trustedRelayerIsm(relayer: string) {
  return {
    type: IsmType.TRUSTED_RELAYER,
    relayer,
  } as const;
}

function cctpOrTrustedRelayerIsm(
  owner: string,
  relayer: string,
): AggregationIsmConfig {
  return {
    type: IsmType.AGGREGATION,
    threshold: 1,
    modules: [
      {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner,
        urls: DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS,
      },
      trustedRelayerIsm(relayer),
    ],
  };
}

function getTrustedRelayer(local: ChainName, remote: ChainName): string {
  return local === 'solanamainnet' || remote === 'solanamainnet'
    ? HYPERLANE_RELAYER
    : FAST_PATH_RELAYER;
}

function getInterchainSecurityModule(
  local: ChainName,
  owner: string,
): RoutingIsmConfig | ReturnType<typeof trustedRelayerIsm> {
  if (local === 'solanamainnet') {
    return trustedRelayerIsm(HYPERLANE_RELAYER);
  }

  const domains = Object.fromEntries(
    ROUTE_CHAINS.filter((chain) => chain !== local).map((remote) => [
      remote,
      local !== 'citrea' && CCTP_CAPABLE_CHAINS.includes(remote)
        ? cctpOrTrustedRelayerIsm(owner, getTrustedRelayer(local, remote))
        : trustedRelayerIsm(getTrustedRelayer(local, remote)),
    ]),
  );

  return {
    type: IsmType.ROUTING,
    owner,
    domains,
  };
}

export async function getUSDCMoonpayWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const existingConfig = await getExistingWarpDeployConfig(
    STAGING_SOURCE_WARP_ROUTE_ID,
  );
  const solanamainnetOwner =
    existingConfig.solanamainnet.owner ??
    abacusWorksEnvOwnerConfig.solanamainnet.owner;
  const arbitrumOwner =
    existingConfig.arbitrum.owner ?? abacusWorksEnvOwnerConfig.arbitrum.owner;
  const baseOwner =
    existingConfig.base.owner ?? abacusWorksEnvOwnerConfig.base.owner;
  const citreaOwner =
    existingConfig.citrea.owner ?? abacusWorksEnvOwnerConfig.citrea.owner;
  const ethereumOwner =
    existingConfig.ethereum.owner ?? abacusWorksEnvOwnerConfig.ethereum.owner;
  const katanaOwner =
    existingConfig.katana.owner ?? abacusWorksEnvOwnerConfig.katana.owner;

  return {
    ...existingConfig,
    solanamainnet: {
      ...existingConfig.solanamainnet,
      mailbox: routerConfig.solanamainnet.mailbox,
      owner: solanamainnetOwner,
      type: TokenType.crossCollateral,
      token: SOLANA_XO_TOKEN_MINT,
      name: SOLANA_XO_NAME,
      symbol: SOLANA_XO_SYMBOL,
      decimals: 6,
      interchainSecurityModule: getInterchainSecurityModule(
        'solanamainnet',
        solanamainnetOwner,
      ),
    },
    arbitrum: {
      ...existingConfig.arbitrum,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: arbitrumOwner,
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDC,
      interchainSecurityModule: getInterchainSecurityModule(
        'arbitrum',
        arbitrumOwner,
      ),
    },
    base: {
      ...existingConfig.base,
      mailbox: routerConfig.base.mailbox,
      owner: baseOwner,
      type: TokenType.crossCollateral,
      token: tokens.base.USDC,
      interchainSecurityModule: getInterchainSecurityModule('base', baseOwner),
    },
    citrea: {
      ...existingConfig.citrea,
      mailbox: routerConfig.citrea.mailbox,
      owner: citreaOwner,
      type: TokenType.crossCollateral,
      token: tokens.citrea.ctUSD,
      interchainSecurityModule: getInterchainSecurityModule(
        'citrea',
        citreaOwner,
      ),
    },
    ethereum: {
      ...existingConfig.ethereum,
      mailbox: routerConfig.ethereum.mailbox,
      owner: ethereumOwner,
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDC,
      interchainSecurityModule: getInterchainSecurityModule(
        'ethereum',
        ethereumOwner,
      ),
    },
    katana: {
      ...existingConfig.katana,
      mailbox: routerConfig.katana.mailbox,
      owner: katanaOwner,
      type: TokenType.crossCollateral,
      token: KATANA_VBUSDC_TOKEN,
      interchainSecurityModule: getInterchainSecurityModule(
        'katana',
        katanaOwner,
      ),
    },
  };
}

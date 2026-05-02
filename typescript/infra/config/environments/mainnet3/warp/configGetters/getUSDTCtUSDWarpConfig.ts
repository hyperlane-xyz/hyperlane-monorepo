import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  HypTokenRouterConfig,
  IsmType,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import relayerAddresses from '../../../../relayer.json' with { type: 'json' };
import { DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS } from '../../../utils.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getExistingWarpDeployConfig } from './utils.js';
import { WarpRouteIds } from '../warpIds.js';

const FAST_PATH_RELAYER = relayerAddresses.mainnet3.fastpath;
const HYPERLANE_RELAYER = relayerAddresses.mainnet3.hyperlane;
const CCTP_CAPABLE_CHAINS: ChainName[] = ['arbitrum', 'base', 'ethereum'];
const ROUTE_CHAINS: ChainName[] = [
  'solanamainnet',
  'arbitrum',
  'base',
  'ethereum',
  'citrea',
];

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

function getInterchainSecurityModule(local: ChainName, owner: string) {
  if (local === 'solanamainnet') {
    return trustedRelayerIsm(HYPERLANE_RELAYER);
  }

  return {
    type: IsmType.ROUTING,
    owner,
    domains: Object.fromEntries(
      ROUTE_CHAINS.filter((chain) => chain !== local).map((remote) => [
        remote,
        CCTP_CAPABLE_CHAINS.includes(remote)
          ? cctpOrTrustedRelayerIsm(owner, getTrustedRelayer(local, remote))
          : trustedRelayerIsm(getTrustedRelayer(local, remote)),
      ]),
    ),
  } as const;
}

export async function getUSDTCtUSDWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const existingConfig = await getExistingWarpDeployConfig(
    WarpRouteIds.USDTCtUSD,
  );
  const solanamainnetOwner =
    existingConfig.solanamainnet.owner ??
    abacusWorksEnvOwnerConfig.solanamainnet.owner;
  const arbitrumOwner =
    existingConfig.arbitrum.owner ?? abacusWorksEnvOwnerConfig.arbitrum.owner;
  const baseOwner =
    existingConfig.base.owner ?? abacusWorksEnvOwnerConfig.base.owner;

  return {
    ...existingConfig,
    solanamainnet: {
      ...existingConfig.solanamainnet,
      mailbox: routerConfig.solanamainnet.mailbox,
      owner: solanamainnetOwner,
      type: TokenType.crossCollateral,
      token: tokens.solanamainnet.USDT,
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
      token: tokens.arbitrum.USDT,
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
      token: tokens.base.USDT,
      interchainSecurityModule: getInterchainSecurityModule('base', baseOwner),
    },
  };
}

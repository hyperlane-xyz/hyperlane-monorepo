import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import {
  awProxyAdminAddresses,
  productionOwnersByChain,
} from './getEclipseUSDCWarpConfig.js';
import { awSafes } from '../../governance/safe/aw.js';
import { REBALANCER } from './utils.js';

const awProxyAdminOwners: ChainMap<string> = {
  ethereum: awSafes.ethereum,
  arbitrum: awSafes.arbitrum,
  plasma: awSafes.plasma,
  bsc: awSafes.bsc,
} as const;

export const evmDeploymentChains = ['ethereum', 'arbitrum', 'plasma', 'bsc'];
export const nonEvmDeploymentChains = ['eclipsemainnet', 'solanamainnet'];
const deploymentChains = [
  ...evmDeploymentChains,
  ...nonEvmDeploymentChains,
] as const;

const ownersByChain: Record<(typeof deploymentChains)[number], string> = {
  ...productionOwnersByChain,
  plasma: awSafes.plasma,
};

const programIds = {
  solanamainnet: 'Bk79wMjvpPCh5iQcCEjPWFcG1V2TfgdwaBsWBEYFYSNU',
  eclipsemainnet: '5g5ujyYUNvdydwyDVCpZwPpgYRqH5RYJRi156cxyE3me',
};

const evmScaleOverrides: Record<
  string,
  { numerator: number; denominator: number }
> = {
  bsc: { numerator: 1, denominator: 1e12 },
};

export const getEclipseEthereumSolanaUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const configs: Array<[string, HypTokenRouterConfig]> = [];

  for (const chain of evmDeploymentChains) {
    const token = (tokens as Record<string, Record<string, string>>)[chain]
      ?.USDT;
    assert(token, `Missing USDT token address for ${chain}`);

    const proxyAdminOwner = awProxyAdminOwners[chain];
    assert(proxyAdminOwner, `Missing proxy admin owner for ${chain}`);

    const proxyAdminAddress = awProxyAdminAddresses[chain];

    const chainConfig: HypTokenRouterConfig = {
      mailbox: routerConfig[chain].mailbox,
      owner: ownersByChain[chain],
      type: TokenType.collateral,
      token,
      allowedRebalancers: [REBALANCER],
      ...(evmScaleOverrides[chain] && { scale: evmScaleOverrides[chain] }),
      proxyAdmin: {
        ...(proxyAdminAddress && { address: proxyAdminAddress }),
        owner: proxyAdminOwner,
      },
    };

    configs.push([chain, chainConfig]);
  }

  configs.push([
    'eclipsemainnet',
    {
      mailbox: routerConfig.eclipsemainnet.mailbox,
      owner: ownersByChain.eclipsemainnet,
      type: TokenType.synthetic,
      foreignDeployment: programIds.eclipsemainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  configs.push([
    'solanamainnet',
    {
      type: TokenType.collateral,
      token: tokens.solanamainnet.USDT,
      mailbox: routerConfig.solanamainnet.mailbox,
      foreignDeployment: programIds.solanamainnet,
      owner: ownersByChain.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  return Object.fromEntries(configs);
};

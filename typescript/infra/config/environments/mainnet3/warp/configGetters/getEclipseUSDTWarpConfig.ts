import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert, objFilter } from '@hyperlane-xyz/utils';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awProxyAdmins } from '../../governance/proxy-admin/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { chainOwners } from '../../owners.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { getFixedRoutingFeeConfig, scaleDownConfig } from './utils.js';
import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

const contractVersion = '11.1.0';

const usdtTokenAddresses: Record<string, string> = {
  ethereum: tokens.ethereum.USDT,
  bsc: tokens.bsc.USDT,
  arbitrum: tokens.arbitrum.USDT,
  plasma: tokens.plasma.USDT,
  tron: tokens.tron.USDT,
  solanamainnet: tokens.solanamainnet.USDT,
};

const chainTokenMetadata: Record<string, { name: string; symbol: string }> = {
  ethereum: { name: 'Tether USD', symbol: 'USDT' },
  tron: { name: 'Tether USD', symbol: 'USDT' },
  bsc: { name: 'Tether USD', symbol: 'USDT' },
  arbitrum: { name: 'USD₮0', symbol: 'USD₮0' },
  plasma: { name: 'USDT0', symbol: 'USDT0' },
  solanamainnet: { name: 'USDT', symbol: 'USDT' },
  eclipsemainnet: { name: 'USDT', symbol: 'USDT' },
};

const chainDecimals: Record<string, number> = {
  ethereum: 6,
  tron: 6,
  plasma: 6,
  arbitrum: 6,
  solanamainnet: 6,
  eclipsemainnet: 6,
  bsc: 18,
};

// Convention: use the minimum decimals as the message encoding baseline.
// The contract does not enforce this — each router independently applies its own scale.
// We derive scales here so that all routers agree on the same message amount encoding.
const MESSAGE_DECIMALS = Math.min(...Object.values(chainDecimals));

// also including tron
export const evmDeploymentChains = [
  'ethereum',
  'bsc',
  'arbitrum',
  'plasma',
  'tron',
];

export const nonEvmDeploymentChains = ['eclipsemainnet', 'solanamainnet'];

const deploymentChains = [
  ...evmDeploymentChains,
  ...nonEvmDeploymentChains,
] as const;

export type DeploymentChain = (typeof deploymentChains)[number];

const productionOwnersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  bsc: '0x269Af9E53192AF49a22ff47e30b89dE1375AE1fd', // ICA
  arbitrum: '0xD2757Bbc28C80789Ed679f22Ac65597Cacf51A45', // ICA,
  plasma: awIcas.plasma,
  eclipsemainnet: chainOwners.eclipsemainnet.owner,
  solanamainnet: chainOwners.solanamainnet.owner,
  tron: awIcas.tron,
};

const PRODUCTION_PROGRAM_IDS = {
  eclipsemainnet: '5g5ujyYUNvdydwyDVCpZwPpgYRqH5RYJRi156cxyE3me',
  solanamainnet: 'Bk79wMjvpPCh5iQcCEjPWFcG1V2TfgdwaBsWBEYFYSNU', // Not yet enrolled
};

export interface EclipseUSDTWarpConfigOptions {
  ownersByChain: Record<DeploymentChain, string>;
  programIds: {
    eclipsemainnet: string;
    solanamainnet: string;
  };
  proxyAdmins: ChainMap<{ address?: string; owner: string }>;
}

export const buildEclipseUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  options: EclipseUSDTWarpConfigOptions,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ownersByChain, programIds, proxyAdmins } = options;

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  for (const chain of evmDeploymentChains) {
    const proxyAdmin = proxyAdmins[chain];
    assert(proxyAdmin, `Missing proxyAdmin for chain ${chain}`);

    const usdtToken = usdtTokenAddresses[chain];
    assert(usdtToken, `USDT address not defined for ${chain}`);
    const decimals = chainDecimals[chain];
    assert(decimals != null, `Decimals not defined for ${chain}`);

    const destinations = evmDeploymentChains.filter((c) => c !== chain);

    configs.push([
      chain,
      {
        ...chainTokenMetadata[chain],
        type: TokenType.collateral,
        token: usdtToken,
        owner: ownersByChain[chain],
        proxyAdmin,
        mailbox: routerConfig[chain].mailbox,
        contractVersion: chain === 'ethereum' ? contractVersion : undefined,
        decimals,
        tokenFee: getFixedRoutingFeeConfig(
          getWarpFeeOwner(chain),
          destinations,
          1.5,
        ),
        ...scaleDownConfig(decimals, MESSAGE_DECIMALS),
      },
    ]);
  }

  // Configure non-evm chains
  configs.push([
    'eclipsemainnet',
    {
      ...chainTokenMetadata.eclipsemainnet,
      type: TokenType.synthetic,
      mailbox: routerConfig.eclipsemainnet.mailbox,
      foreignDeployment: programIds.eclipsemainnet,
      owner: ownersByChain.eclipsemainnet,
      hook: 'Hs7KVBU67nBnWhDPZkEFwWqrFMUfJbmY2DQ4gmCZfaZp', // //core-addresses.ts SVM_CORE_ADDRESSES, eclipse igpProgramId
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      decimals: chainDecimals.eclipsemainnet,
    },
  ]);

  configs.push([
    'solanamainnet',
    {
      ...chainTokenMetadata.solanamainnet,
      type: TokenType.collateral,
      token: usdtTokenAddresses.solanamainnet,
      mailbox: routerConfig.solanamainnet.mailbox,
      foreignDeployment: programIds.solanamainnet,
      owner: ownersByChain.solanamainnet,
      hook: 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv', //core-addresses.ts SVM_CORE_ADDRESSES, solana igpProgramId
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      decimals: chainDecimals.solanamainnet,
    },
  ]);

  return Object.fromEntries(configs);
};

export const getEclipseUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  buildEclipseUSDTWarpConfig(routerConfig, {
    ownersByChain: productionOwnersByChain,
    programIds: PRODUCTION_PROGRAM_IDS,
    proxyAdmins: awProxyAdmins,
  });

// Strategies
export const getEclipseUSDTGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(
    objFilter(
      productionOwnersByChain,
      (chain, _v): _v is string => chain === 'ethereum',
    ),
  );

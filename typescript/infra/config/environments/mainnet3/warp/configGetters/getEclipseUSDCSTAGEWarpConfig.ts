import { ChainMap, HypTokenRouterConfig } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

import {
  DeploymentChain,
  buildEclipseUSDCWarpConfig,
  evmDeploymentChains,
} from './getEclipseUSDCWarpConfig.js';
import { getFileSubmitterStrategyConfig } from './utils.js';

const SOLANA_OWNER = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';

const STAGING_PROGRAM_IDS = {
  eclipsemainnet: '6QSWUmEaEcE2KJrU5jq7T11tNRaVsgnG8XULezjg7JjL',
  solanamainnet: 'E5rVV8zXwtc4TKGypCJvSBaYbgxa4XaYg5MS6N9QGdeo',
};

const STAGING_TOKEN_METADATA = {
  symbol: 'USDCSTAGE',
  name: 'USD Coin STAGE',
};

const stagingProxyAdmins: ChainMap<{ address: string; owner: string }> = {
  ethereum: {
    address: '0x7aeB2331dF8f3cA711E693213C8C07923F587F23',
    owner: DEPLOYER,
  },
  arbitrum: {
    address: '0x3c191c2f924b36410329341B29FB369F0bd2aF24',
    owner: DEPLOYER,
  },
  base: {
    address: '0x604610E6B3310852f1599a6eDbEbd6b6b2B766DC',
    owner: DEPLOYER,
  },
  optimism: {
    address: '0xdC370A18444a78EA6287B45Af15B8C3AdaCA3C88',
    owner: DEPLOYER,
  },
  polygon: {
    address: '0x36D930c7782BafE74Ff52CAb54648a1b2ecC48bE',
    owner: DEPLOYER,
  },
  unichain: {
    address: '0xB3DdBB660dE66CeB14541dFF113b94a900536534',
    owner: DEPLOYER,
  },
  ink: {
    address: '0x9ddB557D8B41881D398b0892D4bF4F77D87B7349',
    owner: DEPLOYER,
  },
  worldchain: {
    address: '0xC5950dD031725F4aD22C81deCe90910353f0bf19',
    owner: DEPLOYER,
  },
  avalanche: {
    address: '0x667F04f5ed394F5d486f76faE02967eB344CeE68',
    owner: DEPLOYER,
  },
  hyperevm: {
    address: '0xbA58446d38187C38Ca3948e044bA29cc0ef65EE8',
    owner: DEPLOYER,
  },
  linea: {
    address: '0x20E1897CD584C3788A3C24f5e424345a55ADf90C',
    owner: DEPLOYER,
  },
  monad: {
    address: '0x5Cdd387DAc73D4158FE3E38177B614D64E9D4668',
    owner: DEPLOYER,
  },
};

const stagingOwnersByChain: Record<DeploymentChain, string> = {
  ethereum: DEPLOYER,
  arbitrum: DEPLOYER,
  base: DEPLOYER,
  optimism: DEPLOYER,
  polygon: DEPLOYER,
  unichain: DEPLOYER,
  eclipsemainnet: SOLANA_OWNER,
  solanamainnet: SOLANA_OWNER,
  ink: DEPLOYER,
  worldchain: DEPLOYER,
  avalanche: DEPLOYER,
  hyperevm: DEPLOYER,
  linea: DEPLOYER,
  monad: DEPLOYER,
};

export const getEclipseUSDCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return buildEclipseUSDCWarpConfig(routerConfig, {
    ownersByChain: stagingOwnersByChain,
    programIds: STAGING_PROGRAM_IDS,
    tokenMetadata: STAGING_TOKEN_METADATA,
    proxyAdmins: stagingProxyAdmins,
  });
};

export const getUSDCSTAGEEclipseFileSubmitterStrategyConfig = () =>
  getFileSubmitterStrategyConfig(
    evmDeploymentChains,
    '/tmp/eclipse-usdcstage-combined.json',
  );

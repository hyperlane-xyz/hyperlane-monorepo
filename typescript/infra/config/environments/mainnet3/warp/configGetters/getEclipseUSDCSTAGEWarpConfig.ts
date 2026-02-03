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
  });
};

export const getUSDCSTAGEEclipseFileSubmitterStrategyConfig = () =>
  getFileSubmitterStrategyConfig(
    evmDeploymentChains,
    '/tmp/eclipse-usdcstage-combined.json',
  );

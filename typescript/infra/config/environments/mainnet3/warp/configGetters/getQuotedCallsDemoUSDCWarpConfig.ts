import { CONTRACTS_PACKAGE_VERSION } from '@hyperlane-xyz/core';
import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  TokenFeeType,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { AgentGCPKey } from '../../../../../src/agents/gcp.js';
import { DeployEnvironment } from '../../../../../src/config/environment.js';
import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { Role } from '../../../../../src/roles.js';
import { Contexts } from '../../../../contexts.js';
import { DEPLOYER } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { WarpRouteIds } from '../warpIds.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

const deploymentChains = [
  'arbitrum',
  'ethereum',
  'base',
  'optimism',
  'ink',
  'unichain',
  'avalanche',
  'hyperevm',
  'linea',
  'monad',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

export const getQuotedCallsDemoUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const quoteSignerKey = new AgentGCPKey(
    'mainnet3' as DeployEnvironment,
    Contexts.Hyperlane,
    Role.QuoteSigner,
  );
  await quoteSignerKey.fetch();
  const quoteSigner = quoteSignerKey.address;

  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    [...deploymentChains],
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const configs: ChainMap<HypTokenRouterConfig> = {};

  for (const chain of deploymentChains) {
    const usdcToken =
      usdcTokenAddresses[chain as keyof typeof usdcTokenAddresses];
    if (!usdcToken) continue;

    const rebalancingConfig = rebalancingConfigByChain[chain];

    configs[chain] = {
      type: TokenType.collateral,
      token: usdcToken,
      owner: DEPLOYER,
      mailbox: routerConfig[chain].mailbox,
      contractVersion: CONTRACTS_PACKAGE_VERSION,
      interchainSecurityModule: {
        type: IsmType.TRUSTED_RELAYER,
        relayer: DEPLOYER,
      },
      tokenFee: {
        type: TokenFeeType.OffchainQuotedLinearFee,
        owner: DEPLOYER,
        bps: 5n,
        quoteSigners: [quoteSigner],
      },
      ...(rebalancingConfig && {
        allowedRebalancers: [REBALANCER],
        allowedRebalancingBridges: rebalancingConfig.allowedRebalancingBridges,
      }),
    };
  }

  return configs;
};

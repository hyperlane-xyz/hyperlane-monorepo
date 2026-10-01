import { ethers } from 'ethers';

import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  OwnableConfig,
  SubmissionStrategy,
  SubmitterMetadata,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { legacyEthIcaRouter } from '../../../../../src/config/chain.js';
import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { chainOwners } from '../../owners.js';

import {
  getFixedRoutingFeeConfig,
  getNativeTokenConfigForChain,
} from './utils.js';

const awProxyAdminOwners: ChainMap<string | undefined> = {
  arbitrum: awSafes.arbitrum,
  base: awSafes.base,
  ethereum: awSafes.ethereum,
  optimism: awSafes.optimism,
  robinhood: awIcas.robinhood,
} as const;

const deploymentChains = [
  'arbitrum',
  'base',
  'ethereum',
  'optimism',
  'robinhood',
  'viction',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const nativeChains = [
  'arbitrum',
  'base',
  'ethereum',
  'optimism',
  'robinhood',
] as const satisfies DeploymentChain[];

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  arbitrum: awIcas.arbitrum,
  base: awIcas.base,
  optimism: awIcas.optimism,
  robinhood: awIcas.robinhood,
  viction: awIcas.viction,
};

export const getVictionETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Configure native chains with routing fees (10 bps for transfers to other native chains)
  for (const currentChain of nativeChains) {
    const baseConfig = getNativeTokenConfigForChain(
      currentChain,
      routerConfig,
      ownersByChain,
    );

    const feeDestinations = nativeChains.filter((c) => c !== currentChain);

    configs.push([
      currentChain,
      {
        ...baseConfig,
        decimals: 18,
        tokenFee: getFixedRoutingFeeConfig(
          getWarpFeeOwner(currentChain),
          feeDestinations,
          10,
        ),
        proxyAdmin: {
          owner:
            awProxyAdminOwners[currentChain] ?? chainOwners[currentChain].owner,
        },
      },
    ]);
  }

  // // Viction synthetic config
  configs.push([
    'viction',
    {
      ...routerConfig.viction,
      owner: ownersByChain.viction,
      type: TokenType.synthetic,
      name: 'ETH',
      symbol: 'ETH',
      decimals: 18,
      gas: 50_000,
      interchainSecurityModule: ethers.constants.AddressZero,
    },
  ]);

  return Object.fromEntries(configs);
};

export const getVictionETHStrategyConfig = (): ChainSubmissionStrategy => {
  const safeChain = 'ethereum';
  const safeAddress = awSafes[safeChain];

  const safeSubmitter: SubmitterMetadata = {
    type: TxSubmitterType.GNOSIS_TX_BUILDER,
    chain: safeChain,
    safeAddress,
    version: '1.0',
  };

  const victionIcaStrategy: SubmissionStrategy = {
    submitter: {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: safeChain,
      destinationChain: 'viction',
      owner: safeAddress,
      originInterchainAccountRouter: legacyEthIcaRouter,
      internalSubmitter: safeSubmitter,
    },
  };

  return {
    viction: victionIcaStrategy,
  };
};

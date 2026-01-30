import { ethers } from 'ethers';

import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { legacyEthIcaRouter } from '../../../../../src/config/chain.js';
import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
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
} as const;

const deploymentChains = [
  'arbitrum',
  'base',
  'ethereum',
  'optimism',
  'viction',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const nativeChains = [
  'arbitrum',
  'base',
  'ethereum',
  'optimism',
] as const satisfies DeploymentChain[];

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  arbitrum: '0xD2757Bbc28C80789Ed679f22Ac65597Cacf51A45', // ICA on ethereum
  base: '0x61756c4beBC1BaaC09d89729E2cbaD8BD30c62B7', // ICA on ethereum
  optimism: '0x1E2afA8d1B841c53eDe9474D188Cd4FcfEd40dDC', // ICA on ethereum
  viction: awSafes.viction,
};

export const getVictionETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
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

        tokenFee: getFixedRoutingFeeConfig(
          getWarpFeeOwner(currentChain),
          feeDestinations,
          10n,
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
      ...abacusWorksEnvOwnerConfig.viction,
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

  const safeSubmitter = {
    type: TxSubmitterType.GNOSIS_TX_BUILDER as const,
    chain: safeChain,
    safeAddress,
    version: '1.0',
  };

  const victionIcaStrategy = {
    submitter: {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT as const,
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

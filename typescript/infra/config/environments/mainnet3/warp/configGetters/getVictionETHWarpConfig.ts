import { randomUUID } from 'crypto';
import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  SubmissionStrategy,
  SubmitterMetadata,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { legacyEthIcaRouter } from '../../../../../src/config/chain.js';
import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getChainAddresses } from '../../../../registry.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { WARP_FEES_TURNKEY_OWNER } from '../../governance/utils.js';
import { chainOwners } from '../../owners.js';
import { QUOTE_SIGNER } from '../consts.js';

import {
  WarpSubmissionStrategy,
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

  // Native-to-native transfers use signed quotes with a permanent 30 bps fallback.
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
          WARP_FEES_TURNKEY_OWNER,
          feeDestinations,
          30,
          undefined,
          [QUOTE_SIGNER],
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

export const getVictionETHStrategyConfig = (): WarpSubmissionStrategy => {
  const safeChain = 'ethereum';
  const safeAddress = awSafes[safeChain];

  const safeSubmitter: SubmitterMetadata = {
    type: TxSubmitterType.GNOSIS_TX_BUILDER,
    chain: safeChain,
    safeAddress,
    version: '1.0',
  };

  const originInterchainAccountRouter =
    getChainAddresses()[safeChain]?.interchainAccountRouter;
  assert(originInterchainAccountRouter, 'Missing Ethereum ICA router');

  const feeFilepath = `/tmp/eth-viction-turnkey-fees-${randomUUID()}.json`;
  const nativeStrategies: WarpSubmissionStrategy = {};
  for (const chain of nativeChains) {
    nativeStrategies[chain] = {
      submitter:
        chain === safeChain
          ? safeSubmitter
          : {
              type: TxSubmitterType.INTERCHAIN_ACCOUNT,
              chain: safeChain,
              destinationChain: chain,
              owner: safeAddress,
              originInterchainAccountRouter,
              internalSubmitter: safeSubmitter,
            },
      feeSubmitter: { type: 'file', chain, filepath: feeFilepath },
    };
  }

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
    ...nativeStrategies,
    viction: victionIcaStrategy,
  };
};

import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  SubmissionStrategy,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getChainAddresses } from '../../../../registry.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { WarpRouteIds } from '../warpIds.js';

import {
  getFixedRoutingFeeConfig,
  getRebalancingUSDCConfigForChain,
  getSyntheticTokenConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

// Owner addresses for this deployment (ICA-based, origin chain is ethereum)
// ethereum: Igra Safe on ethereum (controls all ICAs below)
// others: ICA deployed on each chain, owned by the ethereum Safe
const ownersByChain = {
  ethereum: '0x442f580802aDa1B1E83DCaf103682C59dAEe904E',
  arbitrum: '0x01ac140de46b26B698b575a1faF7BDD610676B68',
  avalanche: '0x3dA09321C8eA6936abFA8CeE528341368D6bc374',
  base: '0xba1E27ECE55Ff3B2aCbDB1DD06924C65078D220c',
  optimism: '0x6e0e5642A1359158F9B1B435D84d2C023961b22F',
  polygon: '0x9E0e72A2dCE951c8Dd12aB433EB7a346ce85994d',
  igra: '0xe1C9B631fD776442b7E2c91a58C6d713Bb13FF03',
} as const;

const collateralChains = [
  'ethereum',
  'arbitrum',
  'avalanche',
  'base',
  'optimism',
  'polygon',
] as const;

const ORIGIN_CHAIN = 'ethereum' as const;

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  collateralChains,
  [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
);

export const getIgraUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const feeOwner = getWarpFeeOwner('igra');

  return {
    ...Object.fromEntries(
      collateralChains.map((chain) => [
        chain,
        getRebalancingUSDCConfigForChain(
          chain,
          routerConfig,
          ownersByChain,
          rebalancingConfigByChain,
        ),
      ]),
    ),
    igra: {
      ...getSyntheticTokenConfigForChain('igra', routerConfig, ownersByChain),
      tokenFee: getFixedRoutingFeeConfig(feeOwner, collateralChains, 10),
    },
  };
};

export const getIgraUSDCStrategyConfig = (): ChainSubmissionStrategy => {
  const safeAddress = ownersByChain[ORIGIN_CHAIN];
  const originSafeSubmitter = {
    type: TxSubmitterType.GNOSIS_SAFE as const,
    chain: ORIGIN_CHAIN,
    safeAddress,
  };

  const chainAddress = getChainAddresses();
  const originInterchainAccountRouter =
    chainAddress[ORIGIN_CHAIN].interchainAccountRouter;
  assert(
    originInterchainAccountRouter,
    `Could not fetch originInterchainAccountRouter for ${ORIGIN_CHAIN}`,
  );

  const icaChains = ([...collateralChains, 'igra'] as string[]).filter(
    (c) => c !== ORIGIN_CHAIN,
  );

  const icaStrategies: [string, SubmissionStrategy][] = icaChains.map(
    (chain) => [
      chain,
      {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT as const,
          chain: ORIGIN_CHAIN,
          destinationChain: chain,
          owner: safeAddress,
          originInterchainAccountRouter,
          internalSubmitter: originSafeSubmitter,
        },
      },
    ],
  );

  return Object.fromEntries([
    [ORIGIN_CHAIN, { submitter: originSafeSubmitter }],
    ...icaStrategies,
  ]);
};

import assert from 'assert';

import {
  ChainMap,
  ChainName,
  HypTokenRouterConfig,
  MovableTokenConfig,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  arrayToObject,
  intersection,
  objMap,
} from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { usdcTokenAddresses } from '../cctp.js';
import { WarpRouteIds } from '../warpIds.js';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

type RebalancingConfig = Required<
  Pick<MovableTokenConfig, 'allowedRebalancingBridges' | 'allowedRebalancers'>
>;

type CCTPWarpRouteId =
  | WarpRouteIds.MainnetCCTPV1
  | WarpRouteIds.MainnetCCTPV2Standard
  | WarpRouteIds.MainnetCCTPV2Fast;

export function getUSDCRebalancingBridgesConfigFor(
  deploymentChains: readonly ChainName[],
  warpRouteIds: [CCTPWarpRouteId, ...CCTPWarpRouteId[]],
): ChainMap<RebalancingConfig> {
  const registry = getRegistry();

  // Fetch all warp routes and build bridge mappings
  const routeData = warpRouteIds.map((warpRouteId) => {
    const route = registry.getWarpRoute(warpRouteId);
    assert(route, `Warp route ${warpRouteId} not found`);

    const chainSet = new Set(route.tokens.map(({ chainName }) => chainName));
    const bridgesByChain = Object.fromEntries(
      route.tokens.map(({ chainName, addressOrDenom }): [string, string] => {
        assert(
          addressOrDenom,
          `Expected bridge address for ${warpRouteId} on ${chainName}`,
        );
        return [chainName, addressOrDenom];
      }),
    );

    return { chainSet, bridgesByChain };
  });

  // Intersection: only chains present in ALL routes
  const deploymentSet = new Set(deploymentChains);
  const chainSets = routeData.map(({ chainSet }) => chainSet);
  const allSets = [deploymentSet, ...chainSets];
  const rebalanceableChains = [
    ...allSets.reduce((acc, set) => intersection(acc, set)),
  ];

  return objMap(
    arrayToObject(rebalanceableChains),
    (currentChain): RebalancingConfig => {
      // Collect bridges from all routes for this chain
      const bridges = routeData.map(({ bridgesByChain }) => {
        const bridge = bridgesByChain[currentChain];
        assert(bridge, `No bridge found for chain ${currentChain}`);
        return { bridge };
      });

      const allowedRebalancingBridges = Object.fromEntries(
        rebalanceableChains
          .filter((remoteChain) => remoteChain !== currentChain)
          .map((remoteChain) => [remoteChain, bridges]),
      );

      return {
        allowedRebalancers: [REBALANCER],
        allowedRebalancingBridges,
      };
    },
  );
}

export const getRebalancingUSDCConfigForChain = (
  currentChain: keyof typeof usdcTokenAddresses,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: ChainMap<Address>,
  rebalancingConfigByChain: ChainMap<RebalancingConfig>,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  const usdcTokenAddress = usdcTokenAddresses[currentChain];
  assert(
    usdcTokenAddress,
    `USDC token address not found for chain ${currentChain}`,
  );

  const currentRebalancingConfig = rebalancingConfigByChain[currentChain];
  assert(
    currentRebalancingConfig,
    `Rebalancing config not found for chain ${currentChain}`,
  );

  const { allowedRebalancers, allowedRebalancingBridges } =
    currentRebalancingConfig;

  return {
    type: TokenType.collateral,
    token: usdcTokenAddress,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
    allowedRebalancers,
    allowedRebalancingBridges,
  };
};

export const getCollateralTokenConfigForChain = <
  TOwnerAddress extends ChainMap<Address>,
>(
  currentChain: Extract<keyof TOwnerAddress, ChainName>,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: TOwnerAddress,
  collateralTokensByChain: ChainMap<Address>,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  const collateralAddress = collateralTokensByChain[currentChain];
  assert(
    collateralAddress,
    `Collateral token address not found for chain ${currentChain}`,
  );

  return {
    type: TokenType.collateral,
    token: collateralAddress,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
  };
};

export const getSyntheticTokenConfigForChain = <
  TOwnerAddress extends ChainMap<Address>,
>(
  currentChain: Extract<keyof TOwnerAddress, ChainName>,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: TOwnerAddress,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  return {
    type: TokenType.synthetic,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
  };
};

export const getNativeTokenConfigForChain = <
  TOwnerAddress extends ChainMap<Address>,
>(
  currentChain: Extract<keyof TOwnerAddress, ChainName>,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: TOwnerAddress,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  return {
    type: TokenType.native,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
  };
};

/**
 * Creates a RoutingFee configuration with a fixed fee for specified destinations.
 * Destinations not included will have no fee (RoutingFee returns 0 for unconfigured destinations).
 *
 * @param token - The token address for the fee
 * @param owner - The owner address for the fee contract
 * @param feeDestinations - List of destination chains that should have the fee applied
 * @param bps - The fee in basis points to apply for feeDestinations
 */
export function getFixedRoutingFeeConfig(
  token: Address,
  owner: Address,
  feeDestinations: readonly ChainName[],
  bps: bigint,
): TokenFeeConfigInput {
  const feeContracts: Record<ChainName, TokenFeeConfigInput> = {};

  for (const chain of feeDestinations) {
    feeContracts[chain] = {
      type: TokenFeeType.LinearFee,
      token,
      owner,
      bps,
    };
  }

  return {
    type: TokenFeeType.RoutingFee,
    token,
    owner,
    feeContracts,
  };
}

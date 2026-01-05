import assert from 'assert';

import {
  ChainMap,
  ChainName,
  HypTokenRouterConfig,
  MovableTokenConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address, arrayToObject, objMap } from '@hyperlane-xyz/utils';

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
  warpRouteId: CCTPWarpRouteId,
): ChainMap<RebalancingConfig> {
  const registry = getRegistry();

  const mainnetCCTP = registry.getWarpRoute(warpRouteId);

  assert(mainnetCCTP, 'MainnetCCTP warp route not found');

  const cctpBridgeChains = new Set(
    mainnetCCTP.tokens.map(({ chainName }) => chainName),
  );

  const rebalanceableChains = deploymentChains.filter((chain) =>
    cctpBridgeChains.has(chain),
  );

  const cctpBridgesByChain = Object.fromEntries(
    mainnetCCTP.tokens.map(
      ({ chainName, addressOrDenom }): [string, string] => {
        assert(
          addressOrDenom,
          `Expected cctp bridge address to be defined on chain ${chainName}`,
        );

        return [chainName, addressOrDenom];
      },
    ),
  );

  return objMap(
    arrayToObject(rebalanceableChains),
    (currentChain): RebalancingConfig => {
      const cctpBridge = cctpBridgesByChain[currentChain];
      assert(cctpBridge, `No cctp bridge found for chain ${currentChain}`);

      const allowedRebalancingBridges = Object.fromEntries(
        rebalanceableChains
          .filter((remoteChain) => remoteChain !== currentChain)
          .map((remoteChain) => [remoteChain, [{ bridge: cctpBridge }]]),
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

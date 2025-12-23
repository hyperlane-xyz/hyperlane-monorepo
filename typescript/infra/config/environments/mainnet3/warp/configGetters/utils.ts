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

export function getCCTPV2RebalancingBridgesConfigFor(
  deploymentChains: readonly ChainName[],
): ChainMap<RebalancingConfig> {
  const registry = getRegistry();

  // Fetch both V2Standard and V2Fast routes
  const mainnetCCTPV2Standard = registry.getWarpRoute(
    WarpRouteIds.MainnetCCTPV2Standard,
  );
  const mainnetCCTPV2Fast = registry.getWarpRoute(
    WarpRouteIds.MainnetCCTPV2Fast,
  );

  assert(mainnetCCTPV2Standard, 'MainnetCCTPV2Standard warp route not found');
  assert(mainnetCCTPV2Fast, 'MainnetCCTPV2Fast warp route not found');

  // Get all chains that are supported by at least one of the CCTP routes
  const v2StandardChains = new Set(
    mainnetCCTPV2Standard.tokens.map(({ chainName }) => chainName),
  );
  const v2FastChains = new Set(
    mainnetCCTPV2Fast.tokens.map(({ chainName }) => chainName),
  );

  // Chains supported by both routes
  const cctpBridgeChains = new Set(
    [...v2StandardChains].filter((chain) => v2FastChains.has(chain)),
  );

  const rebalanceableChains = deploymentChains.filter((chain) =>
    cctpBridgeChains.has(chain),
  );

  // Build bridge mappings for both V2Standard and V2Fast
  const v2StandardBridgesByChain = Object.fromEntries(
    mainnetCCTPV2Standard.tokens.map(
      ({ chainName, addressOrDenom }): [string, string] => {
        assert(
          addressOrDenom,
          `Expected V2Standard cctp bridge address to be defined on chain ${chainName}`,
        );
        return [chainName, addressOrDenom];
      },
    ),
  );

  const v2FastBridgesByChain = Object.fromEntries(
    mainnetCCTPV2Fast.tokens.map(
      ({ chainName, addressOrDenom }): [string, string] => {
        assert(
          addressOrDenom,
          `Expected V2Fast cctp bridge address to be defined on chain ${chainName}`,
        );
        return [chainName, addressOrDenom];
      },
    ),
  );

  return objMap(
    arrayToObject(rebalanceableChains),
    (currentChain): RebalancingConfig => {
      const v2StandardBridge = v2StandardBridgesByChain[currentChain];
      const v2FastBridge = v2FastBridgesByChain[currentChain];

      assert(
        v2StandardBridge,
        `No V2Standard cctp bridge found for chain ${currentChain}`,
      );
      assert(
        v2FastBridge,
        `No V2Fast cctp bridge found for chain ${currentChain}`,
      );

      const allowedRebalancingBridges = Object.fromEntries(
        rebalanceableChains
          .filter((remoteChain) => remoteChain !== currentChain)
          .map((remoteChain) => {
            // Use bridges on the current chain (not remote chain)
            // Both V2Standard and V2Fast bridges on the current chain can send to any remote chain
            return [
              remoteChain,
              [{ bridge: v2StandardBridge }, { bridge: v2FastBridge }],
            ];
          }),
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
